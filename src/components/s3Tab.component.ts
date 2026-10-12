import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Injector, Input } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    BaseTabComponent,
    DirectoryUpload,
    FileDownload,
    FileUpload,
    LogService,
    MenuItemOptions,
    NotificationsService,
    PlatformService,
    PromptModalComponent,
    RecoveryToken,
    TranslateService,
} from 'tabby-core'
import { S3Item, S3Location, S3ObjectRef, S3Profile } from '../api'
import { LocalEditor } from '../localEditor'
import { baseName, copyName, normalizePrefix, parentPrefix, validateName } from '../paths'
import { runPool } from '../pool'
import { isAuthError, S3Session } from '../session'
import type { DirectoryDownload } from '../tabbyCompat'
import { S3CredentialsService } from '../services/credentials.service'
import { S3Property, S3PropertiesModalComponent } from './s3PropertiesModal.component'

const COPY_CONCURRENCY = 8
const LINK_LIFETIMES = [
    { label: _('Valid for 1 hour'), seconds: 60 * 60 },
    { label: _('Valid for 1 day'), seconds: 24 * 60 * 60 },
    { label: _('Valid for 7 days'), seconds: 7 * 24 * 60 * 60 },
]

type SortColumn = 'name' | 'size' | 'modified'

interface PathSegment {
    name: string
    location: S3Location
}

interface Clipboard {
    mode: 'copy' | 'cut'
    bucket: string
    items: S3Item[]
}

interface CopyPair {
    source: S3ObjectRef
    target: S3ObjectRef
    size: number
}

interface DownloadEntry {
    relativePath: string
    object: S3Item
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
    /** Continuation token for the rest of the current folder; null when it is fully loaded */
    nextToken: string|null = null
    loadingMore = false
    pathSegments: PathSegment[] = []
    error: string|null = null
    /** The error came from rejected credentials, which the user may want to re-enter */
    authError = false
    /** What a long operation is doing right now, shown in the header */
    busy: string|null = null
    editingPath: string|null = null
    showFilter = false
    filterText = ''
    sortColumn: SortColumn = 'name'
    sortDescending = false
    selection = new Set<string>()
    clipboard: Clipboard|null = null
    private lastClicked: S3Item|null = null
    private localEditor: LocalEditor

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
        this.localEditor = new LocalEditor(() => this.session, platform, notifications, translate)
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

    get currentBucket (): string {
        return this.currentLocation.bucket!
    }

    get canGoUp (): boolean {
        return !!this.currentLocation.prefix || (this.currentLocation.bucket !== null && !this.fixedBucket)
    }

    get canWrite (): boolean {
        return this.currentLocation.bucket !== null
    }

    get usesStoredKey (): boolean {
        return this.profile.options.auth === 'keys'
    }

    get selectedItems (): S3Item[] {
        return (this.items ?? []).filter(x => this.selection.has(this.itemId(x)))
    }

    get allSelected (): boolean {
        return !!this.filteredItems.length && this.filteredItems.every(x => this.selection.has(this.itemId(x)))
    }

    // Connection and navigation

    async connect (): Promise<void> {
        this.error = null
        this.authError = false
        let secretKey: string|null = null
        if (this.usesStoredKey) {
            secretKey = await this.getSecretKey()
            if (secretKey === null) {
                this.error = this.translate.instant(_('No secret access key provided'))
                return
            }
        }
        this.session?.destroy()
        this.session = new S3Session(this.profile, secretKey, this.log.create(`s3-${this.profile.name}`))
        await this.navigate(this.currentLocation)
    }

    /** Forgets the stored secret key and asks for it again */
    async changeSecretKey (): Promise<void> {
        await this.credentials.deleteSecretKey(this.profile).catch(() => null)
        await this.connect()
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
        this.clearSelection()
        this.items = null
        this.nextToken = null
        this.error = null
        this.authError = false

        let items: S3Item[] = []
        let nextToken: string|null = null
        try {
            if (location.bucket === null) {
                items = await this.session.listBuckets()
            } else {
                ({ items, nextToken } = await this.session.listPage(location.bucket, location.prefix))
            }
        } catch (error) {
            if (this.location !== location) {
                return
            }
            if (isAuthError(error)) {
                this.showError(error)
            } else if (fallbackOnError && previousLocation !== location) {
                this.notifications.error(error.message)
                await this.navigate(previousLocation, false)
            } else {
                this.showError(error)
            }
            return
        }

        if (this.location !== location) {
            // Navigated elsewhere while this listing was loading
            return
        }
        this.items = this.sortItems(items)
        this.nextToken = nextToken
        this.updateFilteredList()
    }

    async loadMore (): Promise<void> {
        const location = this.currentLocation
        if (!this.session || !this.nextToken || this.loadingMore || !this.items) {
            return
        }
        this.loadingMore = true
        try {
            const page = await this.session.listPage(location.bucket!, location.prefix, this.nextToken)
            if (this.location !== location) {
                return
            }
            this.items = this.sortItems([...this.items, ...page.items])
            this.nextToken = page.nextToken
            this.updateFilteredList()
        } catch (error) {
            this.notifications.error(error.message)
        } finally {
            this.loadingMore = false
        }
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

    // Selection and sorting

    itemId (item: S3Item): string {
        return item.isBucket ? item.name : item.key
    }

    isSelected (item: S3Item): boolean {
        return this.selection.has(this.itemId(item))
    }

    /** Click opens; Ctrl/Cmd+click toggles the selection, Shift+click selects a range */
    onItemClick (item: S3Item, event: MouseEvent): void {
        if (event.shiftKey && this.lastClicked && !item.isBucket) {
            const from = this.filteredItems.indexOf(this.lastClicked)
            const to = this.filteredItems.indexOf(item)
            if (from !== -1 && to !== -1) {
                for (const x of this.filteredItems.slice(Math.min(from, to), Math.max(from, to) + 1)) {
                    this.selection.add(this.itemId(x))
                }
                return
            }
        }
        if ((event.ctrlKey || event.metaKey) && !item.isBucket) {
            this.toggleSelection(item)
            return
        }
        this.open(item)
    }

    toggleSelection (item: S3Item): void {
        const id = this.itemId(item)
        if (this.selection.has(id)) {
            this.selection.delete(id)
        } else {
            this.selection.add(id)
        }
        this.lastClicked = item
    }

    toggleSelectAll (): void {
        if (this.allSelected) {
            this.clearSelection()
        } else {
            for (const item of this.filteredItems) {
                this.selection.add(this.itemId(item))
            }
        }
    }

    clearSelection (): void {
        this.selection.clear()
        this.lastClicked = null
    }

    sortBy (column: SortColumn): void {
        if (this.sortColumn === column) {
            this.sortDescending = !this.sortDescending
        } else {
            this.sortColumn = column
            this.sortDescending = column !== 'name'
        }
        if (this.items) {
            this.items = this.sortItems(this.items)
            this.updateFilteredList()
        }
    }

    sortIcon (column: SortColumn): string {
        if (this.sortColumn !== column) {
            return ''
        }
        return this.sortDescending ? 'fas fa-caret-down' : 'fas fa-caret-up'
    }

    // Downloads

    async download (item: S3Item): Promise<void> {
        const transfer = await this.platform.startDownload(item.name, 0o644, item.size)
        if (!transfer) {
            return
        }
        try {
            await this.session!.download(this.currentBucket, item.key, transfer)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not download {name}: {error}'), { name: item.name, error: error.message }))
        }
    }

    /** Downloads one file with a save dialog, or anything else into a new local folder */
    async downloadItems (items: S3Item[]): Promise<void> {
        if (items.length === 1 && !items[0].isDirectory) {
            await this.download(items[0])
            return
        }
        const bucket = this.currentBucket
        const single = items.length === 1
        const folderName = single ? items[0].name : baseName(this.currentLocation.prefix) || bucket
        try {
            this.busy = this.translate.instant(_('Listing files…'))
            const entries: DownloadEntry[] = []
            for (const item of items) {
                if (!item.isDirectory) {
                    entries.push({ relativePath: item.name, object: item })
                    continue
                }
                for (const object of await this.session!.listRecursive(bucket, item.key)) {
                    entries.push({ relativePath: single ? object.name : `${item.name}/${object.name}`, object })
                }
            }
            this.busy = null
            await this.downloadEntries(bucket, folderName, entries)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not download {name}: {error}'), { name: folderName, error: error.message }))
        } finally {
            this.busy = null
        }
    }

    // Uploads

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
            this.cancelUploads(directory.getChildrens())
            return
        }
        await this.uploadInto(this.currentLocation, directory.getChildrens())
    }

    // Folders and buckets

    async createFolder (): Promise<void> {
        const location = this.currentLocation
        const name = await this.promptName(this.translate.instant(_('Name for the new folder')))
        if (!name) {
            return
        }
        const prefix = `${location.prefix}${name}/`
        try {
            await this.session!.createFolder(location.bucket!, prefix)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not create the folder: {error}'), { error: error.message }))
            return
        }
        await this.navigate({ bucket: location.bucket, prefix })
    }

    async createBucket (): Promise<void> {
        const name = await this.promptName(this.translate.instant(_('Name for the new bucket')))
        if (!name) {
            return
        }
        try {
            await this.session!.createBucket(name)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not create the bucket: {error}'), { error: error.message }))
            return
        }
        await this.navigate({ bucket: name, prefix: '' })
    }

    async deleteBucket (item: S3Item): Promise<void> {
        if (!await this.confirm(
            this.translate.instant(_('Delete the bucket {name}?'), item),
            this.translate.instant(_('Only an empty bucket can be deleted.')),
            this.translate.instant(_('Delete')),
        )) {
            return
        }
        try {
            await this.session!.deleteBucket(item.name)
        } catch (error) {
            this.notifications.error(error.name === 'BucketNotEmpty'
                ? this.translate.instant(_('The bucket {name} isn\'t empty. Delete everything in it first.'), item)
                : this.translate.instant(_('Could not delete {name}: {error}'), { name: item.name, error: error.message }))
            return
        }
        await this.refresh()
    }

    // Deleting, renaming, copying and moving

    async deleteItems (items: S3Item[]): Promise<void> {
        const hasFolders = items.some(x => x.isDirectory)
        const message = this.describeDeletion(items, hasFolders)
        if (!await this.confirm(message, this.describeItems(items), this.translate.instant(_('Delete')))) {
            return
        }

        const location = this.currentLocation
        try {
            this.busy = this.translate.instant(_('Deleting…'))
            const keys: string[] = []
            for (const item of items) {
                if (item.isDirectory) {
                    keys.push(...(await this.session!.listRecursive(location.bucket!, item.key)).map(x => x.key))
                } else {
                    keys.push(item.key)
                }
            }
            await this.session!.deleteObjects(location.bucket!, keys)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not delete: {error}'), { error: error.message }))
        } finally {
            this.busy = null
        }
        await this.refreshIfAt(location)
    }

    async rename (item: S3Item): Promise<void> {
        const name = await this.promptName(this.translate.instant(_('New name for {name}'), item), item.name)
        if (!name || name === item.name) {
            return
        }
        const location = this.currentLocation
        const bucket = location.bucket!
        const folder = parentPrefix(item.key)
        const skip = await this.resolveConflicts(bucket, folder, [{ name, isDirectory: item.isDirectory }])
        if (!skip || skip.size) {
            return
        }
        try {
            await this.transferItems(bucket, [{ item, targetName: name }], bucket, folder, true)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not rename {name}: {error}'), { name: item.name, error: error.message }))
        }
        await this.refreshIfAt(location)
    }

    copyToClipboard (items: S3Item[], mode: 'copy' | 'cut'): void {
        this.clipboard = { mode, bucket: this.currentBucket, items: [...items] }
        this.clearSelection()
    }

    async paste (): Promise<void> {
        const clipboard = this.clipboard
        if (!clipboard) {
            return
        }
        const location = this.currentLocation
        const bucket = location.bucket!
        const sameBucket = clipboard.bucket === bucket
        if (sameBucket && clipboard.items.some(x => x.isDirectory && location.prefix.startsWith(x.key))) {
            this.notifications.error(this.translate.instant(_('Can\'t paste a folder into itself')))
            return
        }

        const sameFolder = (item: S3Item) => sameBucket && parentPrefix(item.key) === location.prefix
        const move = clipboard.mode === 'cut'
        const taken = new Set((this.items ?? []).map(x => x.name))
        let targets = move
            // Moving into the folder the items are already in changes nothing
            ? clipboard.items.filter(x => !sameFolder(x)).map(item => ({ item, targetName: item.name }))
            // Copies into the same folder get new names; elsewhere, they keep theirs
            : clipboard.items.map(item => {
                const targetName = sameFolder(item) ? copyName(item.name, x => taken.has(x)) : item.name
                taken.add(targetName)
                return { item, targetName }
            })

        const skip = await this.resolveConflicts(bucket, location.prefix, targets
            .filter(x => !sameFolder(x.item))
            .map(x => ({ name: x.targetName, isDirectory: x.item.isDirectory })))
        if (!skip) {
            return
        }
        targets = targets.filter(x => !skip.has(x.targetName))

        try {
            await this.transferItems(clipboard.bucket, targets, bucket, location.prefix, move)
            if (move) {
                this.clipboard = null
            }
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not paste: {error}'), { error: error.message }))
        }
        await this.refreshIfAt(location)
    }

    // Other object actions

    async editLocally (item: S3Item): Promise<void> {
        try {
            await this.localEditor.edit(this.currentBucket, item)
        } catch (error) {
            this.notifications.error(this.translate.instant(_('Could not open {name}: {error}'), { name: item.name, error: error.message }))
        }
    }

    async copyLink (item: S3Item, seconds: number, label: string): Promise<void> {
        try {
            const url = await this.session!.getDownloadUrl(this.currentBucket, item.key, seconds)
            this.platform.setClipboard({ text: url })
            this.notifications.notice(this.translate.instant(_('Link copied. {validity}.'), { validity: this.translate.instant(label) }))
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async showProperties (item: S3Item): Promise<void> {
        this.busy = this.translate.instant(_('Loading properties…'))
        const properties = await this.getProperties(item).catch((error: Error) => {
            this.notifications.error(error.message)
            return null
        })
        this.busy = null
        if (!properties) {
            return
        }
        const modal = this.ngbModal.open(S3PropertiesModalComponent, { size: 'lg' })
        modal.componentInstance.title = item.name
        modal.componentInstance.properties = properties
        await modal.result.catch(() => null)
    }

    showContextMenu (item: S3Item, event: MouseEvent): void {
        event.preventDefault()
        if (!this.isSelected(item)) {
            this.clearSelection()
        }
        const items = this.selection.size > 1 ? this.selectedItems : [item]
        this.platform.popupContextMenu(items.length > 1 ? this.buildSelectionMenu(items) : this.buildItemMenu(item), event)
    }

    // Formatting

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

    // Path bar and filter

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
        this.localEditor.dispose()
        this.session?.destroy()
        this.session = null
        super.destroy(skipDestroyedEvent)
    }

    // Helpers

    private showError (error: any): void {
        this.error = error.message
        this.authError = isAuthError(error)
        this.items = []
        this.updateFilteredList()
    }

    private async refreshIfAt (location: S3Location): Promise<void> {
        if (this.currentLocation === location) {
            await this.refresh()
        }
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

    /** Asks for a name for a new or renamed object, folder or bucket; returns null when cancelled or invalid */
    private async promptName (prompt: string, value = ''): Promise<string|null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = prompt
        modal.componentInstance.value = value
        const name = ((await modal.result.catch(() => null))?.value ?? '').trim()
        if (!name) {
            return null
        }
        const problem = validateName(name)
        if (problem) {
            this.notifications.error(this.translate.instant(problem))
            return null
        }
        return name
    }

    private async confirm (message: string, detail: string, action: string): Promise<boolean> {
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message,
            detail,
            buttons: [action, this.translate.instant(_('Cancel'))],
            defaultId: 1,
            cancelId: 1,
        })
        return response === 0
    }

    private describeDeletion (items: S3Item[], hasFolders: boolean): string {
        if (items.length === 1) {
            return items[0].isDirectory
                ? this.translate.instant(_('Delete the folder {name} and everything in it?'), items[0])
                : this.translate.instant(_('Delete {name}?'), items[0])
        }
        return hasFolders
            ? this.translate.instant(_('Delete {count} items, including everything in the folders among them?'), { count: items.length })
            : this.translate.instant(_('Delete {count} items?'), { count: items.length })
    }

    private describeItems (items: S3Item[], limit = 10): string {
        const names = items.slice(0, limit).map(x => x.isDirectory ? `${x.name}/` : x.name)
        if (items.length > limit) {
            names.push(this.translate.instant(_('…and {count} more'), { count: items.length - limit }))
        }
        return names.join('\n')
    }

    /**
     * Checks which of the names already exist in the folder and asks whether to replace them.
     * Returns the names to skip, or null to cancel.
     */
    private async resolveConflicts (bucket: string, prefix: string, entries: { name: string, isDirectory: boolean }[]): Promise<Set<string>|null> {
        const session = this.session!
        const existing = (await Promise.all(entries.map(async entry => {
            try {
                const exists = entry.isDirectory
                    ? await session.folderExists(bucket, `${prefix}${entry.name}/`)
                    : await session.objectExists(bucket, prefix + entry.name)
                return exists ? entry : null
            } catch (error) {
                // E.g. a key allowed to write but not to read; let the operation itself succeed or fail
                console.warn('Could not check whether', entry.name, 'exists:', error)
                return null
            }
        }))).filter((x): x is { name: string, isDirectory: boolean } => !!x)
        if (!existing.length) {
            return new Set()
        }

        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: existing.length === 1
                ? this.translate.instant(_('{name} already exists here'), existing[0])
                : this.translate.instant(_('{count} items already exist here'), { count: existing.length }),
            detail: [
                this.describeItems(existing.map(x => ({ name: x.name, isDirectory: x.isDirectory } as S3Item))),
                '',
                this.translate.instant(_('Replacing overwrites files with the same names and merges folders.')),
            ].join('\n'),
            buttons: [
                this.translate.instant(_('Replace')),
                this.translate.instant(_('Skip')),
                this.translate.instant(_('Cancel')),
            ],
            defaultId: 0,
            cancelId: 2,
        })
        if (response === 2) {
            return null
        }
        return response === 1 ? new Set(existing.map(x => x.name)) : new Set()
    }

    private async uploadInto (location: S3Location, entries: (FileUpload|DirectoryUpload)[]): Promise<void> {
        if (!entries.length) {
            return
        }
        const skip = await this.resolveConflicts(location.bucket!, location.prefix, entries.map(x => ({
            name: x.getName(),
            isDirectory: x instanceof DirectoryUpload,
        })))
        if (!skip) {
            this.cancelUploads(entries)
            return
        }
        this.cancelUploads(entries.filter(x => skip.has(x.getName())))
        await this.uploadEntries(location.bucket!, location.prefix, entries.filter(x => !skip.has(x.getName())))
        await this.refreshIfAt(location)
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

    /** Removes uploads that won't happen from the transfers menu */
    private cancelUploads (entries: (FileUpload|DirectoryUpload)[]): void {
        for (const entry of entries) {
            if (entry instanceof DirectoryUpload) {
                this.cancelUploads(entry.getChildrens())
            } else {
                entry.cancel()
            }
        }
    }

    private async downloadEntries (bucket: string, folderName: string, entries: DownloadEntry[]): Promise<void> {
        const totalSize = entries.reduce((sum, x) => sum + x.object.size, 0)
        const transfer = await this.platform.startDownloadDirectory(folderName, totalSize)
        if (!transfer) {
            return
        }
        try {
            for (const { relativePath, object } of entries) {
                if (transfer.isCancelled()) {
                    return
                }
                transfer.setStatus(relativePath)
                if (object.isDirectory) {
                    await transfer.createDirectory(relativePath)
                } else {
                    const file = await transfer.createFile(relativePath, 0o644, object.size)
                    await this.session!.download(bucket, object.key, this.countInto(transfer, file))
                }
            }
            transfer.setStatus('')
            transfer.setCompleted(true)
        } catch (error) {
            transfer.cancel()
            throw error
        } finally {
            transfer.close()
        }
    }

    /** Wraps a file inside a folder download so that its bytes also move the folder's progress bar */
    private countInto (directory: DirectoryDownload, file: FileDownload): FileDownload {
        return {
            write: async (buffer: Uint8Array) => {
                await file.write(buffer)
                // Protected in FileTransfer; directory downloads don't count their files' bytes by themselves
                ;(directory as any).increaseProgress(buffer.length)
            },
            isCancelled: () => file.isCancelled() || directory.isCancelled(),
            cancel: () => file.cancel(),
            close: () => file.close(),
            setStatus: (status: string) => file.setStatus(status),
        } as unknown as FileDownload
    }

    /** Copies (or moves) items and everything in the folders among them into the target folder */
    private async transferItems (
        sourceBucket: string,
        items: { item: S3Item, targetName: string }[],
        targetBucket: string,
        targetPrefix: string,
        move: boolean,
    ): Promise<void> {
        const session = this.session!
        const pairs: CopyPair[] = []
        try {
            this.busy = this.translate.instant(_('Listing files…'))
            for (const { item, targetName } of items) {
                if (!item.isDirectory) {
                    pairs.push({
                        source: { bucket: sourceBucket, key: item.key },
                        target: { bucket: targetBucket, key: targetPrefix + targetName },
                        size: item.size,
                    })
                    continue
                }
                for (const object of await session.listRecursive(sourceBucket, item.key)) {
                    pairs.push({
                        source: { bucket: sourceBucket, key: object.key },
                        target: { bucket: targetBucket, key: `${targetPrefix}${targetName}/${object.name}` },
                        size: object.size,
                    })
                }
            }

            let done = 0
            const verb = move ? _('Moving {done} of {total}…') : _('Copying {done} of {total}…')
            const report = () => {
                this.busy = this.translate.instant(verb, { done, total: pairs.length })
                this.setProgress(pairs.length ? done / pairs.length : null)
            }
            report()
            await runPool(pairs, COPY_CONCURRENCY, async pair => {
                await session.copyObject(pair.source, pair.target, pair.size)
                done++
                report()
            })
            if (move) {
                this.busy = this.translate.instant(_('Deleting…'))
                await session.deleteObjects(sourceBucket, pairs.map(x => x.source.key))
            }
        } finally {
            this.busy = null
            this.setProgress(null)
        }
    }

    private async getProperties (item: S3Item): Promise<S3Property[]> {
        const session = this.session!
        const row = (name: string, value: string|null|undefined): S3Property[] => value ? [{ name: this.translate.instant(name), value }] : []
        const formatDate = (date: Date|null|undefined) => date ? date.toLocaleString() : null
        const formatBytes = (size: number) => size < 1024 ? this.formatSize(size) : `${this.formatSize(size)} (${size.toLocaleString()} B)`

        if (item.isBucket) {
            const region = await session.getBucketRegion(item.name).catch(() => null)
            return [
                ...row(_('Bucket'), item.name),
                ...row(_('Region'), region),
                ...row(_('Created'), formatDate(item.modified)),
                ...row('S3 URI', `s3://${item.name}/`),
            ]
        }

        const bucket = this.currentBucket
        if (item.isDirectory) {
            const objects = (await session.listRecursive(bucket, item.key)).filter(x => !x.isDirectory)
            const total = objects.reduce((sum, x) => sum + x.size, 0)
            return [
                ...row('S3 URI', `s3://${bucket}/${item.key}`),
                ...row(_('Files'), String(objects.length)),
                ...row(_('Total size'), formatBytes(total)),
            ]
        }

        const head = await session.head(bucket, item.key)
        const size = head.ContentLength ?? item.size
        return [
            ...row('S3 URI', `s3://${bucket}/${item.key}`),
            ...row(_('Size'), formatBytes(size)),
            ...row(_('Last modified'), formatDate(head.LastModified)),
            ...row(_('Content type'), head.ContentType),
            ...row(_('Storage class'), head.StorageClass ?? 'STANDARD'),
            ...row('ETag', head.ETag),
            ...row(_('Version ID'), head.VersionId),
            ...row('Cache-Control', head.CacheControl),
            ...row('Content-Encoding', head.ContentEncoding),
            ...row('Content-Disposition', head.ContentDisposition),
            ...Object.entries(head.Metadata ?? {}).flatMap(([key, value]) => row(`x-amz-meta-${key}`, value)),
        ]
    }

    private buildItemMenu (item: S3Item): MenuItemOptions[] {
        const t = (text: string) => this.translate.instant(text)
        if (item.isBucket) {
            return [
                { label: t(_('Open')), click: () => this.open(item) },
                { label: t(_('Copy S3 URI')), click: () => this.platform.setClipboard({ text: `s3://${item.name}/` }) },
                { label: t(_('Properties')), click: () => this.showProperties(item) },
                { type: 'separator' },
                { label: t(_('Delete bucket')), click: () => this.deleteBucket(item) },
            ]
        }

        const menu: MenuItemOptions[] = []
        if (item.isDirectory) {
            menu.push({ label: t(_('Open')), click: () => this.open(item) })
        } else {
            menu.push({ label: t(_('Edit locally')), click: () => this.editLocally(item) })
        }
        menu.push({ label: t(_('Download')), click: () => this.downloadItems([item]) })
        if (!item.isDirectory) {
            menu.push({
                label: t(_('Copy download link')),
                submenu: LINK_LIFETIMES.map(x => ({
                    label: t(x.label),
                    click: () => this.copyLink(item, x.seconds, x.label),
                })),
            })
        }
        menu.push(
            { label: t(_('Copy S3 URI')), click: () => this.platform.setClipboard({ text: `s3://${this.currentBucket}/${item.key}` }) },
            { type: 'separator' },
            { label: t(_('Copy')), click: () => this.copyToClipboard([item], 'copy') },
            { label: t(_('Cut')), click: () => this.copyToClipboard([item], 'cut') },
        )
        if (this.clipboard && item.isDirectory) {
            menu.push({
                label: t(_('Paste into this folder')),
                click: async () => {
                    await this.navigate({ bucket: this.currentBucket, prefix: item.key })
                    await this.paste()
                },
            })
        }
        menu.push(
            { label: t(_('Rename')), click: () => this.rename(item) },
            { label: t(_('Properties')), click: () => this.showProperties(item) },
            { type: 'separator' },
            { label: t(_('Delete')), click: () => this.deleteItems([item]) },
        )
        return menu
    }

    private buildSelectionMenu (items: S3Item[]): MenuItemOptions[] {
        const count = items.length
        return [
            { label: this.translate.instant(_('Download {count} items'), { count }), click: () => this.downloadItems(items) },
            { type: 'separator' },
            { label: this.translate.instant(_('Copy')), click: () => this.copyToClipboard(items, 'copy') },
            { label: this.translate.instant(_('Cut')), click: () => this.copyToClipboard(items, 'cut') },
            { type: 'separator' },
            { label: this.translate.instant(_('Delete {count} items'), { count }), click: () => this.deleteItems(items) },
        ]
    }

    private sortItems (items: S3Item[]): S3Item[] {
        const direction = this.sortDescending ? -1 : 1
        const compare = (a: S3Item, b: S3Item): number => {
            switch (this.sortColumn) {
                case 'size':
                    return a.size - b.size
                case 'modified':
                    return (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0)
                default:
                    return a.name.localeCompare(b.name, undefined, { numeric: true })
            }
        }
        const dirKey = (x: S3Item) => x.isDirectory ? 1 : 0
        return [...items].sort((a, b) =>
            dirKey(b) - dirKey(a) ||
            direction * compare(a, b) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }))
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
