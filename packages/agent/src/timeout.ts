/**
 * Race a promise against a timeout. Rejects with a clear error if the promise
 * doesn't settle within the deadline, preventing the Lambda from hanging on
 * an unresolved Bedrock/S3 call and exiting with Runtime.NodeJsExit.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err as Error); },
    );
  });
}
