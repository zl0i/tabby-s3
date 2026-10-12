/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ProfileSettingsComponent, PromptModalComponent } from 'tabby-core'
import { S3Profile } from '../api'
import { S3CredentialsService } from '../services/credentials.service'

/** @hidden */
@Component({
    templateUrl: './s3ProfileSettings.component.pug',
})
export class S3ProfileSettingsComponent implements ProfileSettingsComponent<S3Profile> {
    profile: S3Profile
    hasSavedSecretKey = false

    constructor (
        private ngbModal: NgbModal,
        private credentials: S3CredentialsService,
    ) { }

    async ngOnInit () {
        await this.checkSavedSecretKey()
    }

    async checkSavedSecretKey () {
        try {
            this.hasSavedSecretKey = await this.credentials.loadSecretKey(this.profile) !== null
        } catch (e) {
            console.error('Could not check for a saved S3 secret key', e)
        }
    }

    async setSecretKey () {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = `Secret access key for ${this.profile.options.accessKeyId}`
        modal.componentInstance.password = true
        const result = await modal.result.catch(() => null)
        if (result?.value) {
            await this.credentials.saveSecretKey(this.profile, result.value)
            this.hasSavedSecretKey = true
        }
    }

    async clearSavedSecretKey () {
        this.hasSavedSecretKey = false
        await this.credentials.deleteSecretKey(this.profile)
    }
}
