// The tabby-core typings published on npm lag behind the app: they predate the file transfer API below,
// which Tabby has had since v1.0.224. Declare the parts this plugin uses.
import 'tabby-core/typings/api/platform'

declare module 'tabby-core/typings/api/platform' {
    interface FileTransfer {
        getStatus (): string
        setStatus (status: string): void
        setTotalSize (size: number): void
        setCompleted (completed: boolean): void
    }

    interface PlatformService {
        startDownloadDirectory (name: string, estimatedSize?: number): Promise<DirectoryDownload|null>
    }
}

export interface DirectoryDownload {
    isCancelled (): boolean
    cancel (): void
    close (): void
    setStatus (status: string): void
    setCompleted (completed: boolean): void
    createDirectory (relativePath: string): Promise<void>
    createFile (relativePath: string, mode: number, size: number): Promise<import('tabby-core').FileDownload>
}
