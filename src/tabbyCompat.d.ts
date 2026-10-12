/* eslint-disable @typescript-eslint/method-signature-style -- method signatures merge with the class declarations */
// The tabby-core typings published on npm lag behind the app: they predate the file transfer API below,
// which Tabby has had since v1.0.224. Declare the parts this plugin uses.
import 'tabby-core/typings/api/platform'
import type { FileDownload, FileUpload, FileUploadOptions } from 'tabby-core'

declare module 'tabby-core/typings/api/platform' {
    interface FileTransfer {
        getStatus (): string
        setStatus (status: string): void
        setTotalSize (size: number): void
        setCompleted (completed: boolean): void
    }

    interface PlatformService {
        /** With a file path, saves there without asking */
        startDownload (name: string, mode: number, size: number, filePath?: string): Promise<FileDownload|null>
        /** With paths, uploads those files without asking */
        startUpload (options?: FileUploadOptions, paths?: string[]): Promise<FileUpload[]>
        startDownloadDirectory (name: string, estimatedSize?: number): Promise<DirectoryDownload|null>
        pickDirectory (title?: string, buttonLabel?: string): Promise<string|null>
    }
}

export interface DirectoryDownload {
    isCancelled (): boolean
    cancel (): void
    close (): void
    setStatus (status: string): void
    setCompleted (completed: boolean): void
    createDirectory (relativePath: string): Promise<void>
    createFile (relativePath: string, mode: number, size: number): Promise<FileDownload>
}
