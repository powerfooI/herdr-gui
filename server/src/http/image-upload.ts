import { sshCommandArgv } from "../bridge/ssh-command";

export function createImageUploadHandler(args: {
  sshHost: () => string | undefined;
}) {
  return async function handleImageUpload(req: Request): Promise<Response> {
    try {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length === 0) {
        return Response.json({ error: "empty body" }, { status: 400 });
      }
      if (buf.length > 25 * 1024 * 1024) {
        return Response.json(
          { error: "image too large (>25MB)" },
          { status: 413 },
        );
      }
      const ext =
        (req.headers.get("x-image-ext") || "png")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "png";
      const name = `herdr-img-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      const sshHost = args.sshHost();

      if (sshHost) {
        const remotePath = `/tmp/${name}`;
        const proc = Bun.spawn(sshCommandArgv(sshHost, `cat > ${remotePath}`), {
          stdin: buf,
          stdout: "pipe",
          stderr: "pipe",
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          return Response.json(
            { error: `ssh upload failed: ${err.trim() || `exit ${code}`}` },
            { status: 502 },
          );
        }
        return Response.json({ path: remotePath, remote: true });
      }

      const localPath = `/tmp/${name}`;
      await Bun.write(localPath, buf);
      return Response.json({ path: localPath, remote: false });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  };
}
