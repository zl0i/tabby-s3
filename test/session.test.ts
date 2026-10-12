/**
 * Runs against a real S3-compatible storage; skipped unless S3_TEST_ENDPOINT is set. Locally:
 *
 *   docker run -d --rm -p 19000:9000 -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret123 minio/minio server /data
 *   S3_TEST_ENDPOINT=http://127.0.0.1:19000 npm test
 */
import * as assert from 'assert/strict'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { after, before, describe, it } from 'node:test'
import { S3Profile } from '../src/api'
import { isAuthError, S3Session } from '../src/session'
import { runPool } from '../src/pool'

const endpoint = process.env.S3_TEST_ENDPOINT
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'testkey'
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'testsecret123'
const noop = () => undefined
const logger = { info: noop, warn: noop, error: noop, debug: noop, log: noop } as any

function makeProfile (options: Partial<S3Profile['options']> = {}): S3Profile {
    return {
        options: {
            endpoint,
            region: 'us-east-1',
            auth: 'keys',
            accessKeyId,
            awsProfile: '',
            forcePathStyle: true,
            bucket: '',
            prefix: '',
            ...options,
        },
    } as S3Profile
}

class FakeTransfer {
    cancelled = false
    closed = false
    status = ''
    isCancelled () { return this.cancelled }
    cancel () { this.cancelled = true; this.close() }
    close () { this.closed = true }
    setStatus (status: string) { this.status = status }
}

class FakeUpload extends FakeTransfer {
    private position = 0
    constructor (private data: Buffer, private cancelAt: number|null = null) { super() }
    getName () { return 'upload' }
    getSize () { return this.data.length }
    async read (): Promise<Uint8Array> {
        if (this.cancelAt !== null && this.position >= this.cancelAt) {
            this.cancel()
        }
        const chunk = this.data.subarray(this.position, this.position + 256 * 1024)
        this.position += chunk.length
        return new Uint8Array(chunk)
    }
}

class FakeDownload extends FakeTransfer {
    chunks: Buffer[] = []
    async write (buffer: Uint8Array) { this.chunks.push(Buffer.from(buffer)) }
    get data () { return Buffer.concat(this.chunks) }
}

describe('S3Session', { skip: !endpoint && 'S3_TEST_ENDPOINT is not set' }, () => {
    const bucket = `tabby-s3-test-${Date.now()}`
    // eslint-disable-next-line @typescript-eslint/init-declarations
    let session: S3Session

    const upload = (key: string, data: Buffer | string) => session.upload(bucket, key, new FakeUpload(Buffer.from(data)) as any)
    const download = async (key: string) => {
        const transfer = new FakeDownload()
        await session.download(bucket, key, transfer as any)
        return transfer.data
    }
    const keys = async (prefix = '') => (await session.listRecursive(bucket, prefix)).map(x => x.key).sort()

    before(async () => {
        session = new S3Session(makeProfile(), secretAccessKey, logger)
        await session.createBucket(bucket)
    })

    after(async () => {
        await session.deleteFolder(bucket, '')
        await session.deleteBucket(bucket)
        session.destroy()
    })

    it('lists the new bucket', async () => {
        assert.ok((await session.listBuckets()).some(x => x.name === bucket && x.isBucket))
    })

    it('uploads with a content type guessed from the extension', async () => {
        await upload('site/index.html', '<h1>hi</h1>')
        await upload('site/data.bin', 'x')
        assert.equal((await session.head(bucket, 'site/index.html')).ContentType, 'text/html')
        assert.equal((await session.head(bucket, 'site/data.bin')).ContentType, 'application/octet-stream')
    })

    it('uploads large files in parts and downloads them intact', async () => {
        const data = crypto.randomBytes(13 * 1024 * 1024)
        await upload('big/file.bin', data)
        assert.ok((await download('big/file.bin')).equals(data))
    })

    it('leaves nothing behind when an upload is cancelled', async () => {
        const transfer = new FakeUpload(crypto.randomBytes(12 * 1024 * 1024), 2 * 1024 * 1024)
        await session.upload(bucket, 'cancelled.bin', transfer as any)
        assert.ok(transfer.cancelled)
        assert.equal(transfer.status, '')
        assert.equal(await session.objectExists(bucket, 'cancelled.bin'), false)
    })

    it('tells whether objects and folders exist', async () => {
        assert.equal(await session.objectExists(bucket, 'site/index.html'), true)
        assert.equal(await session.objectExists(bucket, 'site/missing.html'), false)
        assert.equal(await session.folderExists(bucket, 'site/'), true)
        assert.equal(await session.folderExists(bucket, 'nope/'), false)
    })

    it('lists folders page by page', async () => {
        const names = Array.from({ length: 1005 }, (_, i) => `many/${String(i).padStart(4, '0')}.txt`)
        await runPool(names, 32, key => session.createFolder(bucket, key))
        await session.createFolder(bucket, 'many/sub/')

        const first = await session.listPage(bucket, 'many/')
        assert.equal(first.items.length, 1000)
        assert.ok(first.nextToken)
        const second = await session.listPage(bucket, 'many/', first.nextToken)
        assert.equal(second.nextToken, null)
        const all = [...first.items, ...second.items]
        assert.equal(all.length, 1006)
        assert.ok(all.some(x => x.isDirectory && x.name === 'sub' && x.key === 'many/sub/'))
        await session.deleteFolder(bucket, 'many/')
        assert.equal(await session.folderExists(bucket, 'many/'), false)
    })

    it('copies objects with their content type', async () => {
        await session.copyObject({ bucket, key: 'site/index.html' }, { bucket, key: 'copy/index (copy).html' }, 11)
        assert.equal((await download('copy/index (copy).html')).toString(), '<h1>hi</h1>')
        assert.equal((await session.head(bucket, 'copy/index (copy).html')).ContentType, 'text/html')
    })

    it('copies large objects part by part', async () => {
        const threshold = S3Session.multipartCopyThreshold
        const partSize = S3Session.multipartCopyPartSize
        S3Session.multipartCopyThreshold = 5 * 1024 * 1024
        S3Session.multipartCopyPartSize = 5 * 1024 * 1024
        try {
            const data = crypto.randomBytes(12 * 1024 * 1024 + 7)
            await upload('big/source.json', data)
            await session.copyObject({ bucket, key: 'big/source.json' }, { bucket, key: 'big/target.json' }, data.length)
            assert.ok((await download('big/target.json')).equals(data))
            assert.equal((await session.head(bucket, 'big/target.json')).ContentType, 'application/json')
        } finally {
            S3Session.multipartCopyThreshold = threshold
            S3Session.multipartCopyPartSize = partSize
        }
    })

    it('deletes objects and folders', async () => {
        await upload('trash/a.txt', 'a')
        await upload('trash/deep/b.txt', 'b')
        await session.deleteObject(bucket, 'trash/a.txt')
        assert.deepEqual(await keys('trash/'), ['trash/deep/b.txt'])
        await session.deleteFolder(bucket, 'trash/')
        assert.deepEqual(await keys('trash/'), [])
    })

    it('makes download links that work without credentials', async () => {
        const url = await session.getDownloadUrl(bucket, 'site/index.html', 60)
        const response = await fetch(url)
        assert.equal(response.status, 200)
        assert.equal(await response.text(), '<h1>hi</h1>')
    })

    it('refuses to delete a bucket that is not empty', async () => {
        await assert.rejects(session.deleteBucket(bucket), (error: any) => error.name === 'BucketNotEmpty')
    })

    it('reports rejected credentials as auth errors', async () => {
        const wrongSecret = new S3Session(makeProfile(), 'wrong', logger)
        const wrongKey = new S3Session(makeProfile({ accessKeyId: 'nobody' }), 'wrong', logger)
        try {
            await assert.rejects(wrongSecret.listBuckets(), (error: any) => isAuthError(error))
            await assert.rejects(wrongKey.listBuckets(), (error: any) => isAuthError(error))
        } finally {
            wrongSecret.destroy()
            wrongKey.destroy()
        }
    })

    it('takes credentials from the environment and from AWS CLI profiles', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-s3-test-'))
        const env = { ...process.env }
        try {
            process.env.AWS_ACCESS_KEY_ID = accessKeyId
            process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey
            const fromEnv = new S3Session(makeProfile({ auth: 'environment', accessKeyId: '' }), null, logger)
            assert.ok((await fromEnv.listBuckets()).some(x => x.name === bucket))
            fromEnv.destroy()

            delete process.env.AWS_ACCESS_KEY_ID
            delete process.env.AWS_SECRET_ACCESS_KEY
            fs.writeFileSync(path.join(dir, 'credentials'), `[minio]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`)
            fs.writeFileSync(path.join(dir, 'config'), '[profile minio]\nregion = us-east-1\n')
            process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, 'credentials')
            process.env.AWS_CONFIG_FILE = path.join(dir, 'config')
            const fromProfile = new S3Session(makeProfile({ auth: 'awsProfile', awsProfile: 'minio', accessKeyId: '', region: '' }), null, logger)
            assert.ok((await fromProfile.listBuckets()).some(x => x.name === bucket))
            fromProfile.destroy()
        } finally {
            process.env = env
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
