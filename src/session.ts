import { Readable } from 'stream'
import {
    S3Client,
    ListBucketsCommand,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { FileDownload, FileUpload, Logger } from 'tabby-core'
import { S3Item, S3Profile } from './api'

const DELETE_BATCH_SIZE = 1000

async function * readUpload (transfer: FileUpload): AsyncGenerator<Buffer> {
    while (true) {
        if (transfer.isCancelled()) {
            throw new Error('Upload cancelled')
        }
        const chunk = await transfer.read()
        if (!chunk.length) {
            return
        }
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    }
}

export class S3Session {
    private client: S3Client

    constructor (profile: S3Profile, secretAccessKey: string, private logger: Logger) {
        this.client = new S3Client({
            endpoint: profile.options.endpoint || undefined,
            region: profile.options.region || 'us-east-1',
            forcePathStyle: profile.options.forcePathStyle,
            followRegionRedirects: true,
            credentials: {
                accessKeyId: profile.options.accessKeyId,
                secretAccessKey,
            },
            // The SDK's default CRC checksums are rejected by many S3-compatible storages
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        })
    }

    async listBuckets (): Promise<S3Item[]> {
        const items: S3Item[] = []
        let token: string|undefined = undefined
        do {
            const page = await this.client.send(new ListBucketsCommand({ ContinuationToken: token }))
            for (const bucket of page.Buckets ?? []) {
                items.push({
                    name: bucket.Name!,
                    key: '',
                    isBucket: true,
                    isDirectory: true,
                    size: 0,
                    modified: bucket.CreationDate ?? null,
                })
            }
            token = page.ContinuationToken
        } while (token)
        return items
    }

    /** Lists the folders and objects directly under the prefix */
    async list (bucket: string, prefix: string): Promise<S3Item[]> {
        const items: S3Item[] = []
        let token: string|undefined = undefined
        do {
            const page = await this.client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix || undefined,
                Delimiter: '/',
                ContinuationToken: token,
            }))
            for (const folder of page.CommonPrefixes ?? []) {
                items.push({
                    name: folder.Prefix!.slice(prefix.length, -1),
                    key: folder.Prefix!,
                    isBucket: false,
                    isDirectory: true,
                    size: 0,
                    modified: null,
                })
            }
            for (const object of page.Contents ?? []) {
                if (object.Key === prefix) {
                    // The folder's own marker object
                    continue
                }
                items.push(this.makeObjectItem(object.Key!, prefix, object.Size, object.LastModified))
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (token)
        return items
    }

    /** Lists every object under the prefix, at any depth, including folder marker objects */
    async listRecursive (bucket: string, prefix: string): Promise<S3Item[]> {
        const items: S3Item[] = []
        let token: string|undefined = undefined
        do {
            const page = await this.client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix || undefined,
                ContinuationToken: token,
            }))
            for (const object of page.Contents ?? []) {
                items.push(this.makeObjectItem(object.Key!, prefix, object.Size, object.LastModified))
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (token)
        return items
    }

    async download (bucket: string, key: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', `${bucket}/${key}`)
        try {
            const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
            const body = response.Body as Readable
            for await (const chunk of body) {
                if (transfer.isCancelled()) {
                    body.destroy()
                    return
                }
                await transfer.write(chunk)
            }
            transfer.close()
        } catch (e) {
            if (transfer.isCancelled()) {
                // Cancelled by the user
                return
            }
            transfer.setStatus(e instanceof Error ? e.message : String(e))
            transfer.cancel()
            throw e
        }
    }

    async upload (bucket: string, key: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', `${bucket}/${key}`)
        try {
            // Splits large files into a multipart upload, and aborts it if reading the file fails
            await new Upload({
                client: this.client,
                params: {
                    Bucket: bucket,
                    Key: key,
                    Body: Readable.from(readUpload(transfer), { objectMode: false }),
                },
            }).done()
            transfer.close()
        } catch (e) {
            if (transfer.isCancelled()) {
                // Cancelled by the user
                return
            }
            transfer.setStatus(e instanceof Error ? e.message : String(e))
            transfer.cancel()
            throw e
        }
    }

    async createFolder (bucket: string, prefix: string): Promise<void> {
        await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '' }))
    }

    async deleteObject (bucket: string, key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    }

    /** Deletes every object under the prefix */
    async deleteFolder (bucket: string, prefix: string): Promise<void> {
        const keys = (await this.listRecursive(bucket, prefix)).map(x => x.key)
        for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
            const response = await this.client.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: keys.slice(i, i + DELETE_BATCH_SIZE).map(Key => ({ Key })),
                    Quiet: true,
                },
            }))
            if (response.Errors?.length) {
                const error = response.Errors[0]
                throw new Error(`Could not delete ${error.Key}: ${error.Message ?? error.Code}`)
            }
        }
    }

    destroy (): void {
        this.client.destroy()
    }

    private makeObjectItem (key: string, prefix: string, size?: number, modified?: Date): S3Item {
        return {
            name: key.slice(prefix.length),
            key,
            isBucket: false,
            isDirectory: key.endsWith('/'),
            size: size ?? 0,
            modified: modified ?? null,
        }
    }
}
