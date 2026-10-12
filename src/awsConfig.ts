import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

function configPath (): string {
    return process.env.AWS_CONFIG_FILE ?? path.join(os.homedir(), '.aws', 'config')
}

function credentialsPath (): string {
    return process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), '.aws', 'credentials')
}

export function parseIni (content: string): Record<string, Record<string, string>|undefined> {
    const sections: Record<string, Record<string, string>|undefined> = {}
    let current: Record<string, string>|null = null
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#') || line.startsWith(';')) {
            continue
        }
        const header = /^\[(.+)\]$/.exec(line)
        if (header) {
            current = sections[header[1].trim()] ??= {}
            continue
        }
        const separator = line.indexOf('=')
        if (current && separator > 0) {
            current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
        }
    }
    return sections
}

async function readIni (filePath: string): Promise<Record<string, Record<string, string>|undefined>> {
    try {
        return parseIni(await fs.readFile(filePath, 'utf-8'))
    } catch {
        return {}
    }
}

/** Profile names from the AWS CLI configuration: `[profile x]` in the config file and `[x]` in the credentials file */
export async function listAwsProfiles (): Promise<string[]> {
    const names = new Set<string>()
    for (const section of Object.keys(await readIni(configPath()))) {
        if (section === 'default') {
            names.add(section)
        } else if (section.startsWith('profile ')) {
            names.add(section.slice('profile '.length).trim())
        }
    }
    for (const section of Object.keys(await readIni(credentialsPath()))) {
        names.add(section)
    }
    return [...names].sort()
}

/** The region the AWS CLI would use for the profile, if any is configured */
export async function getAwsRegion (profile: string|null): Promise<string|null> {
    const fromEnv = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION
    if (fromEnv) {
        return fromEnv
    }
    const name = profile ?? process.env.AWS_PROFILE ?? 'default'
    const config = await readIni(configPath())
    return config[name === 'default' ? 'default' : `profile ${name}`]?.region ?? null
}
