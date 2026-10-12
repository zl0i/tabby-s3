# tabby-s3

S3 storage browser for [Tabby](https://tabby.sh). Works with AWS S3 and S3-compatible storages: MinIO, Cloudflare R2, Yandex Object Storage, Backblaze B2, Wasabi and others.

## Features

- An **S3** profile type: endpoint, region, access key, optional bucket and folder
- A browser tab: buckets, folders and objects, with breadcrumbs, path editing (double-click the path) and a filter
- Download files and whole folders, upload files and folders (also by drag and drop), with progress in Tabby's transfers menu
- Large uploads go as multipart uploads
- Create folders, delete objects and folders, copy an object's `s3://` URI
- The secret access key is kept in Tabby's vault when it is enabled, and in the OS keychain otherwise; it can also be entered on every connection
- Open tabs are restored with their location after a restart

## Setting up a profile

Settings → Profiles & connections → New profile → **S3 storage**.

| Field | Value |
| --- | --- |
| Endpoint | Empty for AWS; otherwise the storage URL, e.g. `http://localhost:9000` (MinIO), `https://<account>.r2.cloudflarestorage.com` (R2), `https://storage.yandexcloud.net` (Yandex) |
| Region | The bucket's region; `us-east-1` if empty. R2 uses `auto`, Yandex `ru-central1` |
| Access key ID | Your access key |
| Path-style addressing | Enable for MinIO and most self-hosted storages |
| Bucket | Optional. Set it when the key can't list buckets; the browser then can't go above it |
| Folder | Optional folder in the bucket to open |

## Installation

Requires Tabby 1.0.224 or newer.

Download `tabby-s3-<version>.tgz` from the [latest release](../../releases/latest), close Tabby and run:

```sh
# Windows
npm install --prefix "%APPDATA%\tabby\plugins" path/to/tabby-s3-<version>.tgz
# macOS
npm install --prefix ~/Library/Application\ Support/tabby/plugins path/to/tabby-s3-<version>.tgz
# Linux
npm install --prefix ~/.config/tabby/plugins path/to/tabby-s3-<version>.tgz
```

The plugins folder also opens from Settings → Plugins → Open Plugins Directory. Start Tabby again, and **S3 storage** shows up among the new profile types.

## Development

```sh
npm install
npm run build        # or: npm run watch
TABBY_PLUGINS=$(pwd) tabby --debug
```

`src/tabbyCompat.d.ts` declares the parts of Tabby's API that are missing from the outdated `tabby-core` typings on npm.

## Releasing

Bump `version` in `package.json`, then push a tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions builds the plugin and attaches `tabby-s3-<version>.tgz` to the release. The AWS SDK is bundled into `dist/index.js`, so the package has no runtime dependencies. To have the plugin listed in Tabby's Plugin Manager, also run `npm publish`: the `tabby-plugin` keyword makes it show up there.
