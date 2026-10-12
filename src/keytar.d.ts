// keytar is a native module that Tabby itself provides at runtime; only the calls used here are declared
declare module 'keytar' {
    export function getPassword (service: string, account: string): Promise<string|null>
    export function setPassword (service: string, account: string, password: string): Promise<void>
    export function deletePassword (service: string, account: string): Promise<boolean>
}
