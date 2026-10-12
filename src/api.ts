import { Profile } from 'tabby-core'

export interface S3Profile extends Profile {
    options: S3ProfileOptions
}

export interface S3ProfileOptions {
    /** Custom endpoint for S3-compatible storages (MinIO, R2, Yandex Object Storage...). Empty means AWS. */
    endpoint: string
    region: string
    accessKeyId: string
    /** Addresses buckets as `endpoint/bucket` instead of `bucket.endpoint`; most self-hosted storages need it */
    forcePathStyle: boolean
    /** Bucket to open; when empty, the browser starts at the bucket list */
    bucket: string
    /** Folder within the bucket to open */
    prefix: string
}

/** A location in the browser: no bucket means the bucket list */
export interface S3Location {
    bucket: string|null
    /** Always empty or ending in "/" */
    prefix: string
}

export interface S3Item {
    name: string
    /** Full object key, or the folder's prefix (ending in "/") */
    key: string
    isBucket: boolean
    isDirectory: boolean
    size: number
    modified: Date|null
}
