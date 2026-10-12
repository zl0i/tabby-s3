import * as keytar from 'keytar'
import { Injectable } from '@angular/core'
import { VaultService } from 'tabby-core'
import { S3Profile } from '../api'

export const VAULT_SECRET_TYPE_S3_SECRET_KEY = 's3:secret-access-key'

/** Keeps secret access keys in the vault when it is enabled, and in the OS keychain otherwise */
@Injectable({ providedIn: 'root' })
export class S3CredentialsService {
    constructor (private vault: VaultService) { }

    async saveSecretKey (profile: S3Profile, secretKey: string): Promise<void> {
        if (this.vault.isEnabled()) {
            await this.vault.addSecret({
                type: VAULT_SECRET_TYPE_S3_SECRET_KEY,
                key: {
                    ...this.getVaultKey(profile),
                    description: `S3: ${profile.options.accessKeyId} @ ${this.getEndpointLabel(profile)}`,
                },
                value: secretKey,
            })
        } else {
            await keytar.setPassword(this.getKeytarService(profile), profile.options.accessKeyId, secretKey)
        }
    }

    async deleteSecretKey (profile: S3Profile): Promise<void> {
        if (this.vault.isEnabled()) {
            await this.vault.removeSecret(VAULT_SECRET_TYPE_S3_SECRET_KEY, this.getVaultKey(profile))
        } else {
            await keytar.deletePassword(this.getKeytarService(profile), profile.options.accessKeyId)
        }
    }

    async loadSecretKey (profile: S3Profile): Promise<string|null> {
        if (!profile.options.accessKeyId) {
            return null
        }
        if (this.vault.isEnabled()) {
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_S3_SECRET_KEY, this.getVaultKey(profile)))?.value ?? null
        }
        try {
            return await keytar.getPassword(this.getKeytarService(profile), profile.options.accessKeyId)
        } catch (e) {
            console.warn(`Failed to load the stored S3 secret key for ${profile.options.accessKeyId}`, e)
            return null
        }
    }

    private getEndpointLabel (profile: S3Profile): string {
        return profile.options.endpoint || 'AWS'
    }

    private getKeytarService (profile: S3Profile): string {
        return `s3@${this.getEndpointLabel(profile)}`
    }

    private getVaultKey (profile: S3Profile) {
        return {
            endpoint: profile.options.endpoint,
            accessKeyId: profile.options.accessKeyId,
        }
    }
}
