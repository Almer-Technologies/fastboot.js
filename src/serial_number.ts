export const isValidSerialNumber = (serial: string): boolean => {
    const pattern = /^A[1-2][0-9]{7}$/;

    return pattern.test(serial);
};

// Create a 1024KB blob filled with zeros
const OEM_SIZE = 1024 * 1024; // 1024KB

// DO NOT FUCKING TOUCH THIS (mihai@almer.com)
const CASE_ID_MAX_SIZE = 23

// DO NOT FUCKING TOUCH THIS (mihai@almer.com)
enum OEM_PACKAGE_VERSION {
    v1 = 1
}

/**
 * Creates a file with a serial number embedded in the last 23 bytes.
 */
export const createImageFile = async (serialNumber: string, signature: string) => {
    if (!isValidSerialNumber(serialNumber)) {
        throw new Error("Invalid serial number");
    }

    if (typeof signature !== "string") {
        throw new Error("No signature provided")
    }

    const version = new Uint8Array(1)
    version[0] = OEM_PACKAGE_VERSION.v1

    const encoder = new TextEncoder()
    const signatureBuffer = encoder.encode(signature)

    const padding = OEM_SIZE - version.length - signatureBuffer.length
        - CASE_ID_MAX_SIZE

    const endPadding = CASE_ID_MAX_SIZE - serialNumber.length;

    const blob = new Blob([
        version, // 1 byte
        signature,// signature
        new Uint8Array(padding).fill(0),// padding
        serialNumber,// final 23 bytes for Serial
        new Uint8Array(endPadding).fill(0) // padding at the end to ensure all 23 bytes are overwritten
    ])

    if (blob.size > OEM_SIZE) {
        throw new Error(`Created blob for OEM does not match the OEM size. Expected maximum ${OEM_SIZE}, got ${blob.size}`)
    }

    return blob;
};
