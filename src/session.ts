import { Readable } from 'stream'
import {
    S3Client,
    S3ClientConfig,
    ListBucketsCommand,
    ListObjectsV2Command,
    GetObjectCommand,
    HeadObjectCommand,
    HeadObjectCommandOutput,
    PutObjectCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCopyCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    CreateBucketCommand,
    DeleteBucketCommand,
    GetBucketLocationCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { FileDownload, FileUpload, Logger } from 'tabby-core'
import { S3Item, S3ObjectRef, S3Profile } from './api'
import { getAwsRegion } from './awsConfig'
import { guessContentType } from './mime'
import { runPool } from './pool'

const DELETE_BATCH_SIZE = 1000
const COPY_PART_CONCURRENCY = 4

const AUTH_ERRORS = [
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'InvalidToken',
    'ExpiredToken',
    'InvalidClientTokenId',
    'CredentialsProviderError',
]

/** Whether the storage rejected the credentials, as opposed to e.g. lacking a permission */
export function isAuthError (error: unknown): boolean {
    const { name, Code } = (error ?? {}) as { name?: string, Code?: string }
    return AUTH_ERRORS.includes(name ?? '') || AUTH_ERRORS.includes(Code ?? '')
}

function isNotFound (error: any): boolean {
    return error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404
}

/** CopySource is "bucket/key" with the key URL-encoded, keeping its slashes */
function copySource (source: S3ObjectRef): string {
    return `${source.bucket}/${source.key.split('/').map(encodeURIComponent).join('/')}`
}

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

export interface S3ListPage {
    items: S3Item[]
    /** Pass to the next call to get the following page; null on the last page */
    nextToken: string|null
}

export class S3Session {
    /** CopyObject handles objects up to 5 GiB; larger ones are copied part by part */
    static multipartCopyThreshold = 5 * 1024 ** 3
    static multipartCopyPartSize = 512 * 1024 ** 2

    private client: S3Client

    /**
     * @param secretAccessKey for the `keys` auth mode; the other modes get credentials from the AWS SDK
     */
    constructor (private profile: S3Profile, secretAccessKey: string|null, private logger: Logger) {
        const { options } = profile
        const config: S3ClientConfig = {
            endpoint: options.endpoint || undefined,
            region: options.region || (async () => await getAwsRegion(this.awsProfileName) ?? 'us-east-1'),
            forcePathStyle: options.forcePathStyle,
            followRegionRedirects: true,
            // The SDK's default CRC checksums are rejected by many S3-compatible storages
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        }
        if (options.auth === 'awsProfile') {
            config.profile = options.awsProfile || undefined
        } else if (options.auth !== 'environment') {
            config.credentials = {
                accessKeyId: options.accessKeyId,
                secretAccessKey: secretAccessKey ?? '',
            }
        }
        this.client = new S3Client(config)
    }

    private get awsProfileName (): string|null {
        return this.profile.options.auth === 'awsProfile' ? this.profile.options.awsProfile || null : null
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

    /** Lists a page (up to 1000) of the folders and objects directly under the prefix */
    async listPage (bucket: string, prefix: string, token: string|null = null): Promise<S3ListPage> {
        const page = await this.client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix || undefined,
            Delimiter: '/',
            ContinuationToken: token ?? undefined,
        }))
        const items: S3Item[] = []
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
        return {
            items,
            nextToken: page.IsTruncated ? page.NextContinuationToken ?? null : null,
        }
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

    async head (bucket: string, key: string): Promise<HeadObjectCommandOutput> {
        return this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    }

    async objectExists (bucket: string, key: string): Promise<boolean> {
        try {
            await this.head(bucket, key)
            return true
        } catch (error) {
            if (isNotFound(error)) {
                return false
            }
            throw error
        }
    }

    /** Whether anything exists under the prefix */
    async folderExists (bucket: string, prefix: string): Promise<boolean> {
        const page = await this.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }))
        return !!page.KeyCount
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
                    ContentType: guessContentType(key),
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

    /** Copies an object with its content type and metadata */
    async copyObject (source: S3ObjectRef, target: S3ObjectRef, size: number): Promise<void> {
        this.logger.info('Copying', `${source.bucket}/${source.key}`, 'to', `${target.bucket}/${target.key}`)
        if (size <= S3Session.multipartCopyThreshold) {
            await this.client.send(new CopyObjectCommand({
                Bucket: target.bucket,
                Key: target.key,
                CopySource: copySource(source),
            }))
            return
        }

        const head = await this.head(source.bucket, source.key)
        const { UploadId } = await this.client.send(new CreateMultipartUploadCommand({
            Bucket: target.bucket,
            Key: target.key,
            ContentType: head.ContentType,
            ContentEncoding: head.ContentEncoding,
            ContentDisposition: head.ContentDisposition,
            CacheControl: head.CacheControl,
            Metadata: head.Metadata,
        }))
        try {
            const partSize = S3Session.multipartCopyPartSize
            const partNumbers = Array.from({ length: Math.ceil(size / partSize) }, (_, i) => i + 1)
            const parts: { PartNumber: number, ETag: string }[] = []
            await runPool(partNumbers, COPY_PART_CONCURRENCY, async partNumber => {
                const start = (partNumber - 1) * partSize
                const end = Math.min(start + partSize, size) - 1
                const result = await this.client.send(new UploadPartCopyCommand({
                    Bucket: target.bucket,
                    Key: target.key,
                    UploadId,
                    PartNumber: partNumber,
                    CopySource: copySource(source),
                    CopySourceRange: `bytes=${start}-${end}`,
                }))
                parts.push({ PartNumber: partNumber, ETag: result.CopyPartResult!.ETag! })
            })
            parts.sort((a, b) => a.PartNumber - b.PartNumber)
            await this.client.send(new CompleteMultipartUploadCommand({
                Bucket: target.bucket,
                Key: target.key,
                UploadId,
                MultipartUpload: { Parts: parts },
            }))
        } catch (error) {
            await this.client.send(new AbortMultipartUploadCommand({ Bucket: target.bucket, Key: target.key, UploadId })).catch(() => null)
            throw error
        }
    }

    async createFolder (bucket: string, prefix: string): Promise<void> {
        await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '' }))
    }

    async deleteObject (bucket: string, key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    }

    async deleteObjects (bucket: string, keys: string[]): Promise<void> {
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

    /** Deletes every object under the prefix */
    async deleteFolder (bucket: string, prefix: string): Promise<void> {
        await this.deleteObjects(bucket, (await this.listRecursive(bucket, prefix)).map(x => x.key))
    }

    async createBucket (bucket: string): Promise<void> {
        const region = await this.client.config.region()
        // us-east-1 is the default location and must not be named; R2 and others use pseudo-regions like "auto"
        const named = !['us-east-1', 'auto', ''].includes(region)
        await this.client.send(new CreateBucketCommand({
            Bucket: bucket,
            CreateBucketConfiguration: named ? { LocationConstraint: region as any } : undefined,
        }))
    }

    /** Deletes an empty bucket; S3 refuses to delete one with objects in it */
    async deleteBucket (bucket: string): Promise<void> {
        await this.client.send(new DeleteBucketCommand({ Bucket: bucket }))
    }

    async getBucketRegion (bucket: string): Promise<string> {
        const result = await this.client.send(new GetBucketLocationCommand({ Bucket: bucket }))
        // An empty location means us-east-1
        return result.LocationConstraint ? result.LocationConstraint : 'us-east-1'
    }

    /** A link anyone can use to download the object until it expires */
    async getDownloadUrl (bucket: string, key: string, expiresInSeconds: number): Promise<string> {
        return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds })
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
