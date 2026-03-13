// Buffer polyfill for music-metadata-browser
// Creates a global Buffer implementation using Uint8Array
const bufferPolyfill = (size) => {
    return new Uint8Array(size);
};
const from = (value) => {
    if (typeof value === 'string') {
        const encoder = new TextEncoder();
        return new Uint8Array(encoder.encode(value));
    }
    if (typeof value === 'object' && value !== null) {
        // Handle ArrayBufferView (including Uint8Array)
        if (value instanceof ArrayBuffer || (typeof value.buffer === 'object' && value.buffer instanceof ArrayBuffer)) {
            const typedArray = value;
            return new Uint8Array(typedArray);
        }
        // Handle array-like objects
        const length = value.length || 0;
        const result = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            result[i] = value[i];
        }
        return result;
    }
    return new Uint8Array(0);
};
const alloc = (size, fill, encoding) => {
    const buffer = new Uint8Array(size);
    if (fill !== undefined) {
        if (typeof fill === 'number') {
            buffer.fill(fill);
        }
        else if (typeof fill === 'string' && encoding) {
            // Simple fill - just use the first byte of encoded string
            const encoder = new TextEncoder();
            const filled = encoder.encode(fill);
            for (let i = 0; i < size; i++) {
                buffer[i] = filled[i % filled.length];
            }
        }
    }
    return buffer;
};
const fromString = (str, encoding) => {
    if (encoding === 'base64') {
        const binaryString = atob(str);
        const length = binaryString.length;
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }
    const encoder = new TextEncoder();
    return encoder.encode(str);
};
// Create a Buffer-like interface
const Buffer = {
    isBuffer: (obj) => obj instanceof Uint8Array,
    byteLength: (str, encoding) => {
        if (encoding === 'base64') {
            const binaryString = atob(str);
            return binaryString.length;
        }
        const encoder = new TextEncoder();
        return encoder.encode(str).length;
    },
    concat: (list, totalLength) => {
        if (!totalLength) {
            totalLength = list.reduce((acc, buf) => acc + buf.length, 0);
        }
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of list) {
            result.set(buf, offset);
            offset += buf.length;
        }
        return result;
    },
};
// Export a Buffer factory function
export function createBuffer(sizeOrValue, encodingOrOffset, encoding) {
    if (typeof sizeOrValue === 'number') {
        const offset = typeof encodingOrOffset === 'number' ? encodingOrOffset : 0;
        return alloc(sizeOrValue, encodingOrOffset, encoding);
    }
    return from(sizeOrValue);
}
// Attach to global for compatibility
if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = {
        from,
        alloc,
        fromString,
        isBuffer: Buffer.isBuffer,
        byteLength: Buffer.byteLength,
        concat: Buffer.concat,
        prototype: Uint8Array.prototype,
    };
}
export default Buffer;
