import { createHash } from "node:crypto";

// test_resumes.py's byte builders, kept because test_api.py imports them. `replicated` is omitted: it
// needs a writer, and nothing outside test_resumes.py used it.
function buildPdf(bodies: Buffer[], trailer: string): Uint8Array {
    const out: Buffer[] = [Buffer.from("%PDF-1.4\n")];
    let length = out[0].length;
    const offsets: number[] = [];
    bodies.forEach((body, index) => {
        offsets.push(length);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
        out.push(chunk);
        length += chunk.length;
    });
    const xref: Buffer[] = [Buffer.from(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`)];
    for (const offset of offsets) xref.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`));
    xref.push(Buffer.from(`trailer\n${trailer}\nstartxref\n${length}\n%%EOF\n`));
    return new Uint8Array(Buffer.concat([...out, ...xref]));
}

function bodies(content: Buffer, contentLength: number): Buffer[] {
    return [
        Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
        Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
        Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
        Buffer.concat([Buffer.from(`<< /Length ${contentLength} >>\nstream\n`), content, Buffer.from("\nendstream")]),
    ];
}

export function miniPdf(text = "Hello Resume"): Uint8Array {
    const content = text === "" ? Buffer.alloc(0) : Buffer.from(`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`);
    const pages = bodies(content, content.length);
    return buildPdf(pages, `<< /Size ${pages.length + 1} /Root 1 0 R >>`);
}

// The 32-byte padding string from PDF 1.7 algorithm 2.
const PADDING = Buffer.from([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9,
    0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const FILE_ID = createHash("md5").update("maxterview test file id").digest();
const PERMISSIONS = -44;

function md5(...parts: Buffer[]): Buffer {
    return createHash("md5").update(Buffer.concat(parts)).digest();
}

function pad(password: string): Buffer {
    return Buffer.concat([Buffer.from(password, "latin1"), PADDING]).subarray(0, 32);
}

function rc4(key: Buffer, data: Buffer): Buffer {
    const state = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) state[i] = i;
    for (let i = 0, j = 0; i < 256; i += 1) {
        j = (j + state[i] + key[i % key.length]) & 0xff;
        [state[i], state[j]] = [state[j], state[i]];
    }
    const out = Buffer.alloc(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k += 1) {
        i = (i + 1) & 0xff;
        j = (j + state[i]) & 0xff;
        [state[i], state[j]] = [state[j], state[i]];
        out[k] = data[k] ^ state[(state[i] + state[j]) & 0xff];
    }
    return out;
}

/** A password-protected PDF, so extraction has to report the paste path instead of decoding it. */
export function encrypted(password = "hunter2"): Uint8Array {
    const user = pad(password);
    const ownerKey = md5(pad("")).subarray(0, 5);
    const owner = rc4(ownerKey, user);
    const permissions = Buffer.alloc(4);
    permissions.writeInt32LE(PERMISSIONS);
    const fileKey = md5(user, owner, permissions, FILE_ID).subarray(0, 5);
    const objectKey = md5(fileKey, Buffer.from([5, 0, 0, 0, 0])).subarray(0, 10);

    const content = Buffer.from("BT /F1 12 Tf 20 100 Td (Hello Resume) Tj ET");
    const pages = bodies(rc4(objectKey, content), content.length);
    pages.push(Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${rc4(fileKey, PADDING).toString("hex")}> /P ${PERMISSIONS} >>`));
    const id = FILE_ID.toString("hex");
    return buildPdf(pages, `<< /Size ${pages.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id}> <${id}>] >>`);
}
