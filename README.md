# LyRex

## Deploying audio extraction

Run LyRex on a long-running Node.js 24+ server with one app instance and a persistent volume. LyRex stores projects and audio in `LYREX_DATA_DIR` (default `.data/extractions`) and runs an FFmpeg worker after each upload. Keep the `engine` directory and installed dependencies available at runtime, and run these commands from the project root.

```sh
npm ci
npm run build -- --preset node-server
npm start
```

Route HTTPS traffic to the Node server. If you use a reverse proxy, configure it to accept request bodies of at least 100,000,000 bytes to support LyRex's 100 MB upload limit. Vercel Functions reject request bodies over 4.5 MB before the extraction endpoint runs. [Vercel Functions limits](https://vercel.com/docs/functions/limitations#request-body-size)
