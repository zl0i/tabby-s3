import { Injectable, Injector } from '@angular/core'
import { TabRecoveryProvider, NewTabParameters, RecoveryToken, ProfilesService } from 'tabby-core'

import { S3TabComponent } from './components/s3Tab.component'

/** @hidden */
@Injectable()
export class RecoveryProvider extends TabRecoveryProvider<S3TabComponent> {
    constructor (private injector: Injector) { super() }

    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'app:s3-tab'
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<S3TabComponent>> {
        return {
            type: S3TabComponent,
            inputs: {
                profile: this.injector.get(ProfilesService).getConfigProxyForProfile(recoveryToken.profile),
                location: recoveryToken.location,
            },
        }
    }
}
