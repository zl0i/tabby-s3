/** Runs the task for every item, at most `concurrency` at a time; after the first error, starts no more tasks and rejects */
export async function runPool<T> (items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    let failed = false
    const worker = async () => {
        while (!failed && next < items.length) {
            try {
                await task(items[next++])
            } catch (error) {
                failed = true
                throw error
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}
