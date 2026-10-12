import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ProfileProvider, TabRecoveryProvider } from 'tabby-core'

import { S3ProfileSettingsComponent } from './components/s3ProfileSettings.component'
import { S3TabComponent } from './components/s3Tab.component'
import { S3ProfilesService } from './profiles'
import { RecoveryProvider } from './recoveryProvider'

/** @hidden */
@NgModule({
    imports: [
        NgbModule,
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ProfileProvider, useClass: S3ProfilesService, multi: true },
        { provide: TabRecoveryProvider, useClass: RecoveryProvider, multi: true },
    ],
    declarations: [
        S3ProfileSettingsComponent,
        S3TabComponent,
    ],
})
export default class S3Module { } // eslint-disable-line @typescript-eslint/no-extraneous-class

export { S3TabComponent }
export * from './api'
