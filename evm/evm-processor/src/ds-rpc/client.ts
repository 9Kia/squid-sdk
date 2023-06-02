import {RpcClient} from '@subsquid/rpc-client'
import {assertNotNull, concurrentMap, def, groupBy, last, splitParallelWork, wait} from '@subsquid/util-internal'
import {
    Batch,
    BatchRequest,
    DataSplit,
    ForkNavigator,
    generateFetchStrides,
    getHeightUpdates,
    HotDatabaseState,
    HotDataSource,
    HotUpdate,
    PollingHeightTracker,
    RequestsTracker
} from '@subsquid/util-internal-processor-tools'
import assert from 'assert'
import {NO_LOGS_BLOOM} from '../ds-archive/mapping'
import {AllFields, BlockData} from '../interfaces/data'
import {DataRequest} from '../interfaces/data-request'
import {Bytes32, Qty} from '../interfaces/evm'
import {getBlockHeight, getBlockName, getTxHash, mapBlock, qty2Int, toRpcDataRequest} from './mapping'
import * as rpc from './rpc'


type Block = BlockData<AllFields>


export interface EvmRpcDataSourceOptions {
    rpc: RpcClient
    finalityConfirmation: number
    pollInterval?: number
    strideSize?: number
    useDebugApiForStateDiffs?: boolean
    useTraceApi?: boolean
}


export class EvmRpcDataSource implements HotDataSource<Block, DataRequest> {
    private rpc: RpcClient
    private strideSize: number
    private finalityConfirmation: number
    private pollInterval: number
    private useDebugApiForStateDiffs: boolean
    private useTraceApi: boolean

    constructor(options: EvmRpcDataSourceOptions) {
        this.rpc = options.rpc
        this.finalityConfirmation = options.finalityConfirmation
        this.strideSize = options.strideSize ?? 10
        this.pollInterval = options.pollInterval ?? 1000
        this.useDebugApiForStateDiffs = options.useDebugApiForStateDiffs ?? false
        this.useTraceApi = options.useTraceApi ?? false
    }

    async getFinalizedHeight(): Promise<number> {
        let height = await this.getHeight()
        return Math.max(0, height - this.finalityConfirmation)
    }

    private async getHeight(): Promise<number> {
        let height: Qty = await this.rpc.call('eth_blockNumber')
        return qty2Int(height)
    }

    async getBlockHash(height: number): Promise<string> {
        let block: rpc.Block = await this.rpc.call(
            'eth_getBlockByNumber',
            ['0x'+height.toString(16), false]
        )
        return block.hash
    }

    @def
    getGenesisHash(): Promise<string> {
        return this.getBlockHash(0)
    }

    async *getHotBlocks(requests: BatchRequest<DataRequest>[], state: HotDatabaseState): AsyncIterable<HotUpdate<Block>> {
        let requestsTracker = new RequestsTracker(
            requests.map(toRpcBatchRequest)
        )

        let heightTracker = new PollingHeightTracker(
            () => this.getHeight(),
            this.pollInterval
        )

        let nav = new ForkNavigator(
            state,
            ref => {
                let height = assertNotNull(ref.height)
                let withTransactions = !!requestsTracker.getRequestAt(height)?.transactions
                if (ref.hash) {
                    return this.getBlock0(ref.hash, withTransactions)
                } else {
                    return this.getBlock0(height, withTransactions)
                }
            },
            block => ({
                height: qty2Int(block.number),
                hash: block.hash,
                parentHash: block.parentHash
            })
        )

        for await (let top of getHeightUpdates(heightTracker, nav.getHeight() + 1)) {
            let update: HotUpdate<Block>
            let retries = 3
            while (true) {
                try {
                    update = await nav.transact(async () => {
                        let {baseHead, finalizedHead, blocks: blocks0} = await nav.move({
                            best: top,
                            finalized: top - this.finalityConfirmation
                        })
                        let blocks = await requestsTracker.processBlocks(
                            blocks0,
                            getBlockHeight,
                            (blocks0, req) => splitParallelWork(
                                20,
                                blocks0,
                                bks0 => this.processBlocks(bks0, req)
                            )
                        )
                        return {
                            blocks,
                            baseHead,
                            finalizedHead
                        }
                    })
                    break
                } catch(err: any) {
                    if (err instanceof ConsistencyError && retries) {
                        retries -= 1
                        await wait(200)
                    } else {
                        throw err
                    }
                }
            }
            yield update
            if (!requestsTracker.hasRequestsAfter(update.finalizedHead.height)) return
        }
    }

    getFinalizedBlocks(
        requests: BatchRequest<DataRequest>[],
        stopOnHead?: boolean
    ): AsyncIterable<Batch<Block>> {
        return concurrentMap(
            5,
            generateFetchStrides({
                requests: requests.map(toRpcBatchRequest),
                heightTracker: new PollingHeightTracker(() => this.getFinalizedHeight(), this.pollInterval),
                strideSize: this.strideSize,
                stopOnHead
            }),
            async s => {
                let blocks0 = await this.getStride0(s)
                let blocks = await this.processBlocks(blocks0, s.request)
                return {
                    blocks,
                    isHead: s.range.to === s.chainHeight
                }
            }
        )
    }

    private async getBlock0(ref: number | string, withTransactions: boolean): Promise<rpc.Block> {
        let block: rpc.Block | null
        if (typeof ref == 'string') {
            block = await this.rpc.call('eth_getBlockByHash', [ref, withTransactions])
        } else {
            block = await this.rpc.call('eth_getBlockByNumber', ['0x'+ref.toString(16), withTransactions])
        }
        if (block == null) {
            throw new ConsistencyError(ref)
        } else {
            return block
        }
    }

    private async getStride0(s: DataSplit<rpc.DataRequest>): Promise<rpc.Block[]> {
        let call = []
        for (let i = s.range.from; i <= s.range.to; i++) {
            call.push({
                method: 'eth_getBlockByNumber',
                params: ['0x'+i.toString(16), s.request.transactions]
            })
        }
        let blocks: rpc.Block[] = await this.rpc.batchCall(call, {
            priority: s.range.from
        })
        for (let i = 1; i < blocks.length; i++) {
            assert.strictEqual(
                blocks[i - 1].hash,
                blocks[i].parentHash,
                'perhaps finality confirmation was not large enough'
            )
        }
        return blocks
    }

    private async processBlocks(blocks: rpc.Block[], request?: rpc.DataRequest): Promise<Block[]> {
        let req = request ?? toRpcDataRequest()
        await this.fetchRequestedData(blocks, req)
        return blocks.map(b => mapBlock(b, !!req.transactionList))
    }

    private async fetchRequestedData(blocks: rpc.Block[], req: rpc.DataRequest): Promise<void> {
        let subtasks = []

        if (req.logs && !req.receipts) {
            subtasks.push(this.fetchLogs(blocks))
        }

        if (req.receipts) {
            subtasks.push(this.fetchReceipts(blocks))
        }

        if (req.traces || req.stateDiffs) {
            let isArbitrumOne = await this.getGenesisHash() === '0x7ee576b35482195fc49205cec9af72ce14f003b9ae69f6ba0faef4514be8b442'
            if (isArbitrumOne) {
                subtasks.push(this.fetchArbitrumOneTraces(blocks, req))
            } else {
                let replayTracers: rpc.TraceTracers[] = []
                if (req.traces) {
                    if (this.useTraceApi) {
                        replayTracers.push('trace')
                    } else {
                        subtasks.push(
                            this.fetchDebugFrames(blocks)
                        )
                    }
                }
                if (req.stateDiffs) {
                    if (this.useDebugApiForStateDiffs) {
                        subtasks.push(
                            this.fetchDebugStateDiffs(blocks)
                        )
                    } else {
                        replayTracers.push('stateDiff')
                    }
                }
                if (replayTracers.length) {
                    subtasks.push(
                        this.fetchReplays(blocks, replayTracers)
                    )
                }
            }
        }

        await Promise.all(subtasks)
    }

    private async fetchLogs(blocks: rpc.Block[]): Promise<void> {
        let logs: rpc.Log[] = await this.rpc.call('eth_getLogs', [{
            fromBlock: blocks[0].number,
            toBlock: last(blocks).number
        }], {
            priority: getBlockHeight(blocks[0])
        })

        let logsByBlock = groupBy(logs, log => log.blockHash)

        for (let block of blocks) {
            let logs = logsByBlock.get(block.hash) || []
            if (logs.length == 0 && block.logsBloom !== NO_LOGS_BLOOM) {
                throw new ConsistencyError(block)
            } else {
                block._logs = logs
            }
        }
    }

    private async fetchReceipts(blocks: rpc.Block[]): Promise<void> {
        let call = []
        for (let block of blocks) {
            for (let tx of block.transactions) {
                call.push({
                    method: 'eth_getTransactionReceipt',
                    params: [getTxHash(tx)]
                })
            }
        }

        let receipts: rpc.TransactionReceipt[] = await this.rpc.batchCall(call, {
            priority: getBlockHeight(blocks[0])
        })

        let receiptsByBlock = groupBy(receipts, r => r.blockHash)

        for (let block of blocks) {
            let rs = receiptsByBlock.get(block.hash) || []
            if (rs.length !== block.transactions.length) {
                throw new ConsistencyError(block)
            }
            for (let i = 0; i < rs.length; i++) {
                if (rs[i].transactionHash !== getTxHash(block.transactions[i])) {
                    throw new ConsistencyError(block)
                }
            }
            block._receipts = rs
        }
    }

    private async fetchReplays(
        blocks: rpc.Block[],
        tracers: rpc.TraceTracers[],
        method: string = 'trace_replayBlockTransactions'
    ): Promise<void> {
        if (tracers.length == 0) return

        let call = []
        for (let block of blocks) {
            call.push({
                method,
                params: [block.number, tracers]
            })
        }

        let replaysByBlock: rpc.TraceTransactionReplay[][] = await this.rpc.batchCall(call, {
            priority: getBlockHeight(blocks[0])
        })

        for (let i = 0; i < blocks.length; i++) {
            let block = blocks[i]
            let replays = replaysByBlock[i]
            let txs = new Set(block.transactions.map(getTxHash))

            for (let rep of replays) {
                if (!rep.transactionHash) { // TODO: Who behaves like that? Arbitrum?
                    let txHash: Bytes32 | undefined = undefined
                    for (let frame of rep.trace || []) {
                        assert(txHash == null || txHash === frame.transactionHash)
                        txHash = txHash || frame.transactionHash
                    }
                    assert(txHash, "Can't match transaction replay with its transaction")
                    rep.transactionHash = txHash
                }
                // Sometimes replays might be missing for pre-compiled contracts
                if (!txs.has(rep.transactionHash)) {
                    throw new ConsistencyError(block)
                }
            }

            block._traceReplays = replays
        }
    }

    private async fetchDebugFrames(blocks: rpc.Block[]): Promise<void> {
        let traceConfig = {
            tracer: 'callTracer',
            tracerConfig: {
                onlyTopCall: false,
                withLog: false // will study log <-> frame matching problem later
            }
        }

        let call = []
        for (let block of blocks) {
            call.push({
                method: 'debug_traceBlockByHash',
                params: [block.hash, traceConfig]
            })
        }

        let results: any[][] = await this.rpc.batchCall(call, {
            priority: getBlockHeight(blocks[0])
        })

        for (let i = 0; i < blocks.length; i++) {
            let block = blocks[i]
            let frames = results[i]

            assert(block.transactions.length === frames.length)

            // Moonbeam quirk
            for (let j = 0; j < frames.length; j++) {
                if (!frames[j].result) {
                    frames[j] = {result: frames[j]}
                }
            }

            block._debugFrames = frames
        }
    }

    private async fetchDebugStateDiffs(blocks: rpc.Block[]): Promise<void> {
        let traceConfig = {
            tracer: 'prestateTracer',
            tracerConfig: {
                onlyTopCall: false, // passing this option is incorrect, but required by Alchemy endpoints
                diffMode: true
            }
        }

        let call = []
        for (let block of blocks) {
            call.push({
                method: 'debug_traceBlockByHash',
                params: [block.hash, traceConfig]
            })
        }

        let results: rpc.DebugStateDiffResult[][] = await this.rpc.batchCall(call, {
            priority: getBlockHeight(blocks[0])
        })

        for (let i = 0; i < blocks.length; i++) {
            let block = blocks[i]
            let diffs = results[i]
            assert(block.transactions.length === diffs.length)
            block._debugStateDiffs = diffs
        }
    }

    private fetchArbitrumOneTraces(blocks: rpc.Block[], req: rpc.DataRequest): Promise<void> {
        let arbBlocks = blocks.filter(b => getBlockHeight(b) <= 22207815)
        let debugBlocks = blocks.filter(b => getBlockHeight(b) >= 22207818)

        let tasks = []
        if (arbBlocks.length) {
            let tracers: rpc.TraceTracers[] = []
            if (req.traces) {
                tracers.push('trace')
            }
            if (req.stateDiffs) {
                tracers.push('stateDiff')
            }
            tasks.push(
                this.fetchReplays(arbBlocks, tracers, 'arbtrace_replayBlockTransactions')
            )
        }

        if (debugBlocks.length) {
            if (req.traces) {
                tasks.push(
                    this.fetchDebugFrames(debugBlocks)
                )
            }
            if (req.stateDiffs) {
                tasks.push(
                    this.fetchDebugStateDiffs(debugBlocks)
                )
            }
        }

        return Promise.all(tasks).then()
    }
}


class ConsistencyError extends Error {
    constructor(block: rpc.Block | number | string) {
        let name = typeof block == 'object' ? getBlockName(block) : block
        super(`Seems like the chain node navigated to another branch while we were fetching block ${name}`)
    }
}


function toRpcBatchRequest(request: BatchRequest<DataRequest>): BatchRequest<rpc.DataRequest> {
    return {
        range: request.range,
        request: toRpcDataRequest(request.request)
    }
}
