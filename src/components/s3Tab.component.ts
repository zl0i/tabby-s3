import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Injector, Input } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    BaseTabComponent,
    DirectoryUpload,
    FileUpload,
    LogService,
    MenuItemOptions,
    NotificationsService,
    PlatformService,
    PromptModalComponent,
    RecoveryToken,
    TranslateService,
} from 'tabby-core'
import { S3Item, S3Location, S3Profile } from '../api'
import { S3Session } from '../session'
import type { DirectoryDownload } from '../tabbyCompat'
import { S3CredentialsService } from '../services/credentials.service'

interface PathSegment {
    name: string
    location: S3Location
}

function normalizePrefix (prefix: string|null|undefined): string {
    const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
    return trimmed ? `${trimmed}/` : ''
}

function parentPrefix (prefix: string): string {
    const withoutSlash = prefix.slice(0, -1)
    return withoutSlash.slice(0, withoutSlash.lastIndexOf('/') + 1)
}

/** @hidden */
@Component({
    selector: 's3-tab',
    templateUrl: './s3Tab.component.pug',
    styleUrls: ['./s3Tab.component.scss'],
})
export class S3TabComponent extends BaseTabComponent {
    @Input() profile: S3Profile
    @Input() location: S3Location|undefined
    session: S3Session|null = null
    items: S3Item[]|null = null
    filteredItems: S3Item[] = []
    pathSegments: PathSegment[] = []
    error: string|null = null
    editingPath: string|null = null
    showFilter = false
    filterText = ''

    constructor (
        injector: Injector,
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        private credentials: S3CredentialsService,
        private log: LogService,
        private translate: TranslateService,
        public platform: PlatformService,
    ) {
        super(injector)
    }

    async ngOnInit (): Promise<void> {
        this.setTitle(this.profile.name)
        this.location ??= {
            bucket: this.fixedBucket,
            prefix: this.fixedBucket ? normalizePrefix(this.profile.options.prefix) : '',
        }
        await this.connect()
    }

    /** The bucket the profile is limited to, if any; the browser can't go above it */
    get fixedBucket (): string|null {
        return this.profile.options.bucket || null
    }

    get currentLocation (): S3Location {
        return this.location!
    }

    get canGoUp (): boolean {
        return !!this.currentLocation.prefix || (this.currentLocation.bucket !== null && !this.fixedBucket)
    }

    get canWrite (): boolean {
        return this.currentLocation.bucket !== null
    }

    async connect (): Promise<void> {
        this.error = null
        const secretKey = await this.getSecretKey()
        if (secretKey === null) {
            this.error = this.translate.instant(_('No secret access key provided'))
            return
        }
        this.session?.destroy()
        this.session = new S3Session(this.profile, secretKey, this.log.create(`s3-${this.profile.options.accessKeyId}`))
        await this.navigate(this.currentLocation)
    }

    async navigate (location: S3Location, fallbackOnError = true): Promise<void> {
        if (!this.session) {
            return
        }
        const previousLocation = this.currentLocation
        this.location = location
        this.recoveryStateChangedHint.next()
        this.updatePathSegments()
        this.clearFilter()
        this.items = null
        this.error = null

        let items: S3Item[] = []
        try {
            items = location.bucket === null
                ? await this.session.listBuckets()
                : await this.session.list(location.bucket, location.prefix)
        } catch (error) {
            if (this.location !== location) {
                return
            }
            this.notifications.error(error.message)
            if (fallbackOnError && previousLocation !== location) {
                await this.navigate(previousLocation, false)
            } else {
                this.error = error.message
                this.items = []
                this.updateFilteredList()
            }
            return
        }

        if (this.location !== location) {
            // Navigated elsewhere while this listing was loading
            return
        }
        const dirKey = (x: S3Item) => x.isDirectory ? 1 : 0
        items.sort((a, b) => dirKey(b) - dirKey(a) || a.name.localeCompare(b.name))
        this.items = items
        this.updateFilteredList()
    }

    refresh (): Promise<void> {
        return this.navigate(this.currentLocation)
    }

    goUp (): void {
        const { bucket, prefix } = this.currentLocation
        if (prefix) {
            this.navigate({ bucket, prefix: parentPrefix(prefix) })
        } else if (!this.fixedBucket) {
            this.navigate({ bucket: null, prefix: '' })
        }
    }

    async open (item: S3Item): Promise<void> {
        if (item.isBucket) {
            await this.navigate({ bucket: item.name, prefix: '' })
        } else if (item.isDirectory) {
            await this.navigate({ bucket: this.currentLocation.bucket, prefix: item.key })
        } else {
            await this.download(item)
        }
    }

    async download (item: S3Item): Promise<void> {
        const bucket = this.currentLocation.bucket!
        const transfer = await this.platform.startDownload(item.name, 0o644, item.size)
        if (!transfer) {
            return
        }
        try {
            await this.session!.download(bucket, item.key, transfer)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not download {name}: {error}'), { name: item.name, error: error.message }))
        }
    }

    async downloadFolder (folder: S3Item): Promise<void> {
        const bucket = this.currentLocation.bucket!
        let transfer: DirectoryDownload|null = null
        try {
            const objects = await this.session!.listRecursive(bucket, folder.key)
            const totalSize = objects.reduce((sum, x) => sum + x.size, 0)
            transfer = await this.platform.startDownloadDirectory(folder.name, totalSize)
            if (!transfer) {
                return
            }
            for (const object of objects) {
                if (transfer.isCancelled()) {
                    return
                }
                transfer.setStatus(object.name)
                if (object.isDirectory) {
                    await transfer.createDirectory(object.name)
                } else {
                    const fileTransfer = await transfer.createFile(object.name, 0o644, object.size)
                    await this.session!.download(bucket, object.key, fileTransfer)
                }
            }
            transfer.setStatus('')
            transfer.setCompleted(true)
        } catch (error) {
            transfer?.cancel()
            this.notifications.error(this.translate.instant(_('Could not download {name}: {error}'), { name: folder.name, error: error.message }))
        } finally {
            transfer?.close()
        }
    }

    async upload (): Promise<void> {
        const transfers = await this.platform.startUpload({ multiple: true })
        await this.uploadInto(this.currentLocation, transfers)
    }

    async uploadFolder (): Promise<void> {
        const directory = await this.platform.startUploadDirectory()
        await this.uploadInto(this.currentLocation, [directory])
    }

    async uploadDropped (directory: DirectoryUpload): Promise<void> {
        if (!this.canWrite) {
            return
        }
        await this.uploadInto(this.currentLocation, directory.getChildrens())
    }

    async createFolder (): Promise<void> {
        const location = this.currentLocation
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.translate.instant(_('Name for the new folder'))
        const name = normalizePrefix((await modal.result.catch(() => null))?.value)
        if (!name) {
            return
        }
        try {
            await this.session!.createFolder(location.bucket!, location.prefix + name)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not create the folder: {error}'), { error: error.message }))
            return
        }
        await this.navigate({ bucket: location.bucket, prefix: location.prefix + name })
    }

    async delete (item: S3Item): Promise<void> {
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: item.isDirectory
                ? this.translate.instant(_('Delete the folder {name} and everything in it?'), item)
                : this.translate.instant(_('Delete {name}?'), item),
            buttons: [
                this.translate.instant(_('Delete')),
                this.translate.instant(_('Cancel')),
            ],
            defaultId: 1,
            cancelId: 1,
        })
        if (response !== 0) {
            return
        }

        const location = this.currentLocation
        try {
            if (item.isDirectory) {
                await this.session!.deleteFolder(location.bucket!, item.key)
            } else {
                await this.session!.deleteObject(location.bucket!, item.key)
            }
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not delete {name}: {error}'), { name: item.name, error: error.message }))
        }
        if (this.currentLocation === location) {
            await this.refresh()
        }
    }

    showContextMenu (item: S3Item, event: MouseEvent): void {
        event.preventDefault()
        const bucket = item.isBucket ? item.name : this.currentLocation.bucket
        const menu: MenuItemOptions[] = []
        if (item.isDirectory) {
            menu.push({
                label: this.translate.instant(_('Open')),
                click: () => this.open(item),
            })
        }
        if (!item.isBucket) {
            menu.push({
                label: this.translate.instant(_('Download')),
                click: () => item.isDirectory ? this.downloadFolder(item) : this.download(item),
            })
        }
        menu.push({
            label: this.translate.instant(_('Copy S3 URI')),
            click: () => this.platform.setClipboard({ text: `s3://${bucket}/${item.key}` }),
        })
        if (!item.isBucket) {
            menu.push({ type: 'separator' })
            menu.push({
                label: this.translate.instant(_('Delete')),
                click: () => this.delete(item),
            })
        }
        this.platform.popupContextMenu(menu, event)
    }

    formatSize (size: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let unit = 0
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024
            unit++
        }
        return `${unit ? size.toFixed(1) : size} ${units[unit]}`
    }

    getIcon (item: S3Item): string {
        if (item.isBucket) {
            return 'fas fa-database text-info'
        }
        if (item.isDirectory) {
            return 'fas fa-folder text-info'
        }
        return 'fas fa-file'
    }

    editPath (): void {
        const { bucket, prefix } = this.currentLocation
        this.editingPath = bucket === null ? '/' : `/${bucket}/${prefix}`
    }

    confirmPath (): void {
        if (this.editingPath === null) {
            return
        }
        const [bucket, ...rest] = this.editingPath.replace(/^\/+/, '').split('/')
        this.editingPath = null
        if (this.fixedBucket && bucket !== this.fixedBucket) {
            this.notifications.error(this.translate.instant(_('This profile is limited to the {bucket} bucket'), { bucket: this.fixedBucket }))
            return
        }
        this.navigate({
            bucket: bucket || null,
            prefix: bucket ? normalizePrefix(rest.join('/')) : '',
        })
    }

    clearFilter (): void {
        this.showFilter = false
        this.filterText = ''
        this.updateFilteredList()
    }

    onFilterChange (): void {
        this.updateFilteredList()
    }

    async getRecoveryToken (): Promise<RecoveryToken> {
        return {
            type: 'app:s3-tab',
            profile: this.profile,
            location: this.location,
        }
    }

    destroy (skipDestroyedEvent = false): void {
        this.session?.destroy()
        this.session = null
        super.destroy(skipDestroyedEvent)
    }

    private async getSecretKey (): Promise<string|null> {
        const savedKey = await this.credentials.loadSecretKey(this.profile)
        if (savedKey !== null) {
            return savedKey
        }
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.translate.instant(_('Secret access key for {accessKeyId}'), this.profile.options)
        modal.componentInstance.password = true
        modal.componentInstance.showRememberCheckbox = true
        const result = await modal.result.catch(() => null)
        if (!result?.value) {
            return null
        }
        if (result.remember) {
            await this.credentials.saveSecretKey(this.profile, result.value)
        }
        return result.value
    }

    private async uploadInto (location: S3Location, entries: (FileUpload|DirectoryUpload)[]): Promise<void> {
        await this.uploadEntries(location.bucket!, location.prefix, entries)
        if (this.currentLocation === location) {
            await this.refresh()
        }
    }

    private async uploadEntries (bucket: string, prefix: string, entries: (FileUpload|DirectoryUpload)[]): Promise<void> {
        await Promise.all(entries.map(async entry => {
            const key = prefix + entry.getName()
            if (entry instanceof DirectoryUpload) {
                if (!entry.getChildrens().length) {
                    // S3 has no directories; keep an empty one visible with a folder marker
                    await this.session!.createFolder(bucket, `${key}/`).catch(() => null)
                }
                await this.uploadEntries(bucket, `${key}/`, entry.getChildrens())
                return
            }
            try {
                await this.session!.upload(bucket, key, entry)
            } catch (error) {
                this.notifications.error(this.translate.instant(_('Could not upload {name}: {error}'), { name: entry.getName(), error: error.message }))
            }
        }))
    }

    private updatePathSegments (): void {
        const { bucket, prefix } = this.currentLocation
        this.pathSegments = []
        if (!this.fixedBucket) {
            this.pathSegments.push({ name: 'S3', location: { bucket: null, prefix: '' } })
        }
        if (bucket === null) {
            return
        }
        this.pathSegments.push({ name: bucket, location: { bucket, prefix: '' } })
        let accumulated = ''
        for (const part of prefix.split('/').filter(x => x)) {
            accumulated += `${part}/`
            this.pathSegments.push({ name: part, location: { bucket, prefix: accumulated } })
        }
    }

    private updateFilteredList (): void {
        if (!this.items) {
            this.filteredItems = []
            return
        }
        const query = this.filterText.trim().toLowerCase()
        this.filteredItems = this.showFilter && query
            ? this.items.filter(x => x.name.toLowerCase().includes(query))
            : this.items
    }
}
