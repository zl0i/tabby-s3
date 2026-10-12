/** Turns user input like "/a/b" or "a/b/" into an S3 prefix: empty, or ending in "/" without a leading one */
export function normalizePrefix (prefix: string|null|undefined): string {
    const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
    return trimmed ? `${trimmed}/` : ''
}

/** The folder containing a key or prefix: "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "a.txt" -> "" */
export function parentPrefix (key: string): string {
    const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
    return trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
}

/** The last segment of a key or prefix: "a/b/c.txt" -> "c.txt", "a/b/" -> "b" */
export function baseName (key: string): string {
    const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
    return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** Makes a name that isn't taken: "a.txt" -> "a (copy).txt", "a (copy 2).txt"... */
export function copyName (name: string, isTaken: (candidate: string) => boolean): string {
    const dot = name.lastIndexOf('.')
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let candidate = `${stem} (copy)${extension}`
    for (let i = 2; isTaken(candidate); i++) {
        candidate = `${stem} (copy ${i})${extension}`
    }
    return candidate
}

/** Checks a name for a new object, folder or bucket; returns an error message, or null when it is fine */
export function validateName (name: string): string|null {
    if (!name.trim()) {
        return 'The name is empty'
    }
    if (name.includes('/')) {
        return 'The name can\'t contain "/"'
    }
    if (name === '.' || name === '..') {
        return 'The name can\'t be "." or ".."'
    }
    return null
}
