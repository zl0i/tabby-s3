import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { S3Item } from './api'
import { S3Session } from './session'

const POLL_INTERVAL = 1000

/**
 * Opens objects in their default local apps, and uploads them back whenever they are saved.
 * Watches by polling the modification time, which survives editors that save by replacing the file.
 */
export class LocalEditor {
    private stopWatching: (() => void)[] = []
    private tempDirs: string[] = []

    constructor (
        private getSession: () => S3Session|null,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    async edit (bucket: string, item: S3Item): Promise<void> {
        const session = this.getSession()
        if (!session) {
            return
        }
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-s3-'))
        this.tempDirs.push(tempDir)
        const filePath = path.join(tempDir, item.name.replace(/[\\/:*?"<>|]/g, '_'))

        const transfer = await this.platform.startDownload(item.name, 0o600, item.size, filePath)
        if (!transfer) {
            return
        }
        await session.download(bucket, item.key, transfer)
        if (transfer.isCancelled()) {
            return
        }

        let uploads = Promise.resolve()
        const listener = (current: fs.Stats, previous: fs.Stats) => {
            if (current.mtimeMs !== previous.mtimeMs && current.mtimeMs) {
                uploads = uploads.then(() => this.uploadBack(bucket, item, filePath))
            }
        }
        fs.watchFile(filePath, { interval: POLL_INTERVAL }, listener)
        this.stopWatching.push(() => fs.unwatchFile(filePath, listener))

        this.platform.openPath(filePath)
        this.notifications.info(this.translate.instant('Changes to {name} are uploaded back while this tab is open', item))
    }

    /** Stops uploading changes and deletes the local copies */
    dispose (): void {
        for (const stop of this.stopWatching) {
            stop()
        }
        this.stopWatching = []
        for (const dir of this.tempDirs) {
            // A file still open in an editor can't be deleted on Windows; the OS cleans the temp folder later
            fs.promises.rm(dir, { recursive: true, force: true }).catch(() => null)
        }
        this.tempDirs = []
    }

    private async uploadBack (bucket: string, item: S3Item, filePath: string): Promise<void> {
        const session = this.getSession()
        if (!session) {
            return
        }
        const transfers = await this.platform.startUpload({ multiple: false }, [filePath])
        if (!transfers.length) {
            return
        }
        const transfer = transfers[0]
        try {
            await session.upload(bucket, item.key, transfer)
            this.notifications.notice(this.translate.instant('Uploaded {name}', item))
        } catch (error) {
            this.notifications.error(this.translate.instant('Could not upload {name}: {error}', { name: item.name, error: error.message }))
        }
    }
}
