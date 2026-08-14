# Reliable QR File Transfer

A React/Vite proof-of-concept for reliable air-gapped file transfer using QR codes.

## Core reliability model

The sender prepares one compressed transfer and then repeats the complete chunk stream for multiple rounds. The receiver maintains a map of `sequence -> payload`, so receiving the same sequence multiple times is harmless. The transfer is finalized only when:

1. Every expected sequence number exists.
2. The compressed byte stream is rebuilt in sequence order.
3. The stream is decompressed successfully.
4. SHA-256 of the original file equals the manifest hash.

This directly addresses the failure mode of fast QR streams where individual chunks are missed by the receiver.

## Protocol

Frames are JSON wrapped as:

```text
["RQFT", 1, frameType, transferId, frame]
```

Frame types:

- `M` manifest
- `D` data chunk
- `E` end marker

The receiver ignores frames belonging to another transfer and ignores duplicate sequence numbers.

## Recommended operating mode

For camera-based transfers, begin around 140–200 ms per QR frame. Increase the interval if the receiver is missing many chunks. Increase rounds when the environment is noisy or the camera is moving.

## Run

```bash
npm install
npm run dev
```

For an offline deployment, run `npm run build` once on a connected machine, then serve the generated `dist/` folder without external CDN dependencies.

## Next production upgrades

1. Add a receiver-to-sender QR acknowledgement channel for selective retransmission.
2. Add fountain/FEC coding so the sender does not need to repeat all source chunks.
3. Add optional AES-GCM encryption with a passphrase or pre-shared key.
4. Move file processing to streams/workers for large files.
5. Add durable receiver state in IndexedDB so scanning can pause/resume safely.
6. Add automated protocol tests with intentional frame loss, duplication, and reordering.
