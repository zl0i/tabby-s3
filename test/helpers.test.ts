import * as assert from 'assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it } from 'node:test'
import { baseName, copyName, normalizePrefix, parentPrefix, validateName } from '../src/paths'
import { guessContentType } from '../src/mime'
import { runPool } from '../src/pool'
import { getAwsRegion, listAwsProfiles, parseIni } from '../src/awsConfig'

describe('paths', () => {
    it('normalizes prefixes', () => {
        assert.equal(normalizePrefix(''), '')
        assert.equal(normalizePrefix(null), '')
        assert.equal(normalizePrefix('/'), '')
        assert.equal(normalizePrefix('/a/b'), 'a/b/')
        assert.equal(normalizePrefix('a/b//'), 'a/b/')
    })

    it('finds the parent folder of keys and prefixes', () => {
        assert.equal(parentPrefix('a/b/c.txt'), 'a/b/')
        assert.equal(parentPrefix('a/b/'), 'a/')
        assert.equal(parentPrefix('a/'), '')
        assert.equal(parentPrefix('a.txt'), '')
    })

    it('takes the last segment', () => {
        assert.equal(baseName('a/b/c.txt'), 'c.txt')
        assert.equal(baseName('a/b/'), 'b')
        assert.equal(baseName(''), '')
    })

    it('makes copy names that are not taken', () => {
        const taken = new Set(['a (copy).txt', 'a (copy 2).txt'])
        assert.equal(copyName('a.txt', x => taken.has(x)), 'a (copy 3).txt')
        assert.equal(copyName('folder', () => false), 'folder (copy)')
        assert.equal(copyName('.env', () => false), '.env (copy)')
    })

    it('validates names', () => {
        assert.equal(validateName('report.pdf'), null)
        assert.notEqual(validateName(' '), null)
        assert.notEqual(validateName('a/b'), null)
        assert.notEqual(validateName('..'), null)
    })
})

describe('mime', () => {
    it('guesses content types from extensions', () => {
        assert.equal(guessContentType('index.HTML'), 'text/html')
        assert.equal(guessContentType('a/b/photo.jpeg'), 'image/jpeg')
        assert.equal(guessContentType('archive.tar.gz'), 'application/gzip')
        assert.equal(guessContentType('Makefile'), 'application/octet-stream')
        assert.equal(guessContentType('file.unknownext'), 'application/octet-stream')
    })
})

describe('pool', () => {
    it('runs every task with limited concurrency', async () => {
        let running = 0
        let peak = 0
        const done: number[] = []
        await runPool([1, 2, 3, 4, 5, 6, 7], 3, async x => {
            running++
            peak = Math.max(peak, running)
            await new Promise(resolve => setTimeout(resolve, 5))
            done.push(x)
            running--
        })
        assert.equal(peak, 3)
        assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7])
    })

    it('stops starting tasks after an error', async () => {
        const started: number[] = []
        await assert.rejects(runPool([1, 2, 3, 4, 5, 6], 1, async x => {
            started.push(x)
            if (x === 2) {
                throw new Error('boom')
            }
        }), /boom/)
        assert.deepEqual(started, [1, 2])
    })
})

describe('awsConfig', () => {
    it('parses INI sections', () => {
        assert.deepEqual(parseIni('# comment\n[default]\nregion = eu-west-1\n\n[profile dev]\nregion=us-west-2\n'), {
            'default': { region: 'eu-west-1' },
            'profile dev': { region: 'us-west-2' },
        })
    })

    it('lists profiles and finds their regions', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-s3-test-'))
        const env = { ...process.env }
        try {
            fs.writeFileSync(path.join(dir, 'config'), '[default]\nregion = eu-west-1\n[profile dev]\nregion = us-west-2\n[sso-session x]\n')
            fs.writeFileSync(path.join(dir, 'credentials'), '[default]\naws_access_key_id = a\n[ci]\naws_access_key_id = b\n')
            process.env.AWS_CONFIG_FILE = path.join(dir, 'config')
            process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, 'credentials')
            delete process.env.AWS_REGION
            delete process.env.AWS_DEFAULT_REGION
            delete process.env.AWS_PROFILE

            assert.deepEqual(await listAwsProfiles(), ['ci', 'default', 'dev'])
            assert.equal(await getAwsRegion('dev'), 'us-west-2')
            assert.equal(await getAwsRegion(null), 'eu-west-1')
            assert.equal(await getAwsRegion('ci'), null)
            process.env.AWS_REGION = 'ap-south-1'
            assert.equal(await getAwsRegion('dev'), 'ap-south-1')
        } finally {
            process.env = env
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
