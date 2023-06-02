import {HttpClient} from '@subsquid/http-client'
import {wait, withErrorContext} from '@subsquid/util-internal'
import {
    archiveIngest,
    Batch,
    BatchRequest,
    DataSource,
    DataSplit,
    PollingHeightTracker
} from '@subsquid/util-internal-processor-tools'
import assert from 'assert'
import {AllFields, BlockData} from '../interfaces/data'
import {DataRequest} from '../interfaces/data-request'
import {Bytes32} from '../interfaces/evm'
import * as gw from './gateway'
import {mapGatewayBlock, withDefaultFields} from './mapping'


type Block = BlockData<AllFields>


export class EvmArchive implements DataSource<Block, DataRequest> {
    constructor(private http: HttpClient) {}

    getFinalizedHeight(): Promise<number> {
        return this.http.get('/height').then(s => parseInt(s))
    }

    async getBlockHash(height: number): Promise<Bytes32> {
        let blocks = await this.query({
            fromBlock: height,
            toBlock: height,
            includeAllBlocks: true
        })
        assert(blocks.length == 1)
        return blocks[0].header.hash
    }

    getFinalizedBlocks(requests: BatchRequest<DataRequest>[], stopOnHead?: boolean | undefined): AsyncIterable<Batch<Block>> {
        return archiveIngest({
            requests,
            heightTracker: new PollingHeightTracker(() => this.getFinalizedHeight(), 10_000),
            query: s => this.fetchSplit(s),
            stopOnHead
        })
    }

    private async fetchSplit(s: DataSplit<DataRequest>): Promise<Block[]> {
        let blocks = await this.query({
            fromBlock: s.range.from,
            toBlock: s.range.to,
            fields: withDefaultFields(s.request.fields),
            includeAllBlocks: !!s.request.includeAllBlocks,
            transactions: s.request.transactions,
            logs: s.request.logs,
            traces: s.request.traces,
            stateDiffs: s.request.stateDiffs
        })
        return blocks.map(mapGatewayBlock)
    }

    private async query(q: gw.BatchRequest): Promise<gw.BlockData[]> {
        let blocks: gw.BlockData[] | undefined = undefined
        let retrySchedule = [5000, 10000, 20000]
        let retries = 0
        while (blocks == null) {
            blocks = await this.performQuery(q).catch(async err => {
                if (this.http.isRetryableError(err)) {
                    let pause = retrySchedule[Math.min(retries, retrySchedule.length - 1)]
                    retries += 1
                    await wait(pause)
                    return undefined
                }
                throw err
            })
        }
        return blocks
    }

    private async performQuery(q: gw.BatchRequest): Promise<gw.BlockData[]> {
        let worker: string = await this.http.get(`/${q.fromBlock}/worker`)
        return this.http.post(worker, {json: q, retryAttempts: 2, retrySchedule: [1000]})
            .catch(withErrorContext({archiveQuery: q}))
    }
}
