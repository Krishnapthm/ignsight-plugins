import { uploadWithLock } from "./uploader.js";
import { listPairings } from "./workspace.js";
// Detached uploader started by hooks: `node dist/upload.js <pairing key>`.
// It prints nothing; failures stay recorded in the pairing's state.json.
try {
    const pairing = (await listPairings()).find((item) => item.key === process.argv[2]);
    if (pairing)
        await uploadWithLock(pairing);
}
catch { /* Status reports the last recorded error; the buffer is kept for the next attempt. */ }
