import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { PlatformService } from 'tabby-core'

export interface S3Property {
    name: string
    value: string
}

/** @hidden */
@Component({
    templateUrl: './s3PropertiesModal.component.pug',
    styleUrls: ['./s3PropertiesModal.component.scss'],
})
export class S3PropertiesModalComponent {
    @Input() title: string
    @Input() properties: S3Property[] = []

    constructor (
        public modal: NgbActiveModal,
        private platform: PlatformService,
    ) { }

    copy (property: S3Property): void {
        this.platform.setClipboard({ text: property.value })
    }
}
