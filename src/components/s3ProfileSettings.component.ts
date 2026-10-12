/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, map } from 'rxjs'
import { ProfileSettingsComponent, PromptModalComponent } from 'tabby-core'
import { S3Profile } from '../api'
import { listAwsProfiles } from '../awsConfig'
import { S3CredentialsService } from '../services/credentials.service'

/** @hidden */
@Component({
    templateUrl: './s3ProfileSettings.component.pug',
})
export class S3ProfileSettingsComponent implements ProfileSettingsComponent<S3Profile> {
    profile: S3Profile
    hasSavedSecretKey = false
    awsProfiles: string[] = []

    constructor (
        private ngbModal: NgbModal,
        private credentials: S3CredentialsService,
    ) { }

    awsProfilesAutocomplete = (text$: Observable<string>) => text$.pipe(map(query =>
        this.awsProfiles.filter(x => !query || x.toLowerCase().includes(query.toLowerCase())),
    ))

    async ngOnInit () {
        this.awsProfiles = await listAwsProfiles()
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
