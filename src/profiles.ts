import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, ProfileProvider, TranslateService } from 'tabby-core'
import { S3ProfileSettingsComponent } from './components/s3ProfileSettings.component'
import { S3TabComponent } from './components/s3Tab.component'
import { S3Profile } from './api'

@Injectable({ providedIn: 'root' })
export class S3ProfilesService extends ProfileProvider<S3Profile> {
    id = 's3'
    name = _('S3')
    settingsComponent = S3ProfileSettingsComponent
    configDefaults = {
        options: {
            endpoint: '',
            region: '',
            accessKeyId: '',
            forcePathStyle: false,
            bucket: '',
            prefix: '',
        },
    }

    constructor (private translate: TranslateService) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<S3Profile>[]> {
        return [{
            id: 's3:template',
            type: 's3',
            name: this.translate.instant('S3 storage'),
            icon: 'fas fa-database',
            isBuiltin: true,
            isTemplate: true,
        }]
    }

    async getNewTabParameters (profile: S3Profile): Promise<NewTabParameters<S3TabComponent>> {
        return {
            type: S3TabComponent,
            inputs: { profile },
        }
    }

    getSuggestedName (profile: PartialProfile<S3Profile>): string {
        return this.getDescription(profile)
    }

    getDescription (profile: PartialProfile<S3Profile>): string {
        const host = profile.options?.endpoint?.replace(/^\w+:\/\//, '') || 'AWS'
        return profile.options?.bucket ? `${profile.options.bucket} @ ${host}` : host
    }
}
