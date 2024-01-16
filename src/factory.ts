import * as common from "./common";
import {
    ZipReader,
    BlobReader,
    BlobWriter,
    TextWriter,
    Entry,
    // @ts-ignore
    EntryGetDataOptions,
    Writer,
} from "@zip.js/zip.js";
import {FastbootDevice, FastbootError, ReconnectCallback} from "./fastboot";
import {createImageFile} from "./serial_number";

/**
 * Callback for factory image flashing progress.
 *
 * @callback FactoryProgressCallback
 * @param {string} action - Action in the flashing process, e.g. unpack/flash.
 * @param {string} item - Item processed by the action, e.g. partition being flashed.
 * @param {number} progress - Progress within the current action between 0 and 1.
 */
export type FactoryProgressCallback = (
    action: string,
    item: string,
    progress: number
) => void;

// Images needed for fastbootd
const BOOT_CRITICAL_IMAGES = [
    "boot",
    "dt",
    "dtbo",
    "init_boot",
    "pvmfw",
    "recovery",
    "vbmeta_system",
    "vbmeta_vendor",
    "vbmeta",
    "vendor_boot",
    "vendor_kernel_boot",
];

// Less critical images to flash after boot-critical ones
const SYSTEM_IMAGES = [
    "odm",
    "odm_dlkm",
    "product",
    "system_dlkm",
    "system_ext",
    "system",
    "vendor_dlkm",
    "vendor",
];

/**
 * User-friendly action strings for factory image flashing progress.
 * This can be indexed by the action argument in FactoryFlashCallback.
 */
export const USER_ACTION_MAP = {
    load: "Loading",
    unpack: "Unpacking",
    flash: "Writing",
    wipe: "Wiping",
    reboot: "Restarting",
};

const BOOTLOADER_REBOOT_TIME = 4000; // ms
const FASTBOOTD_REBOOT_TIME = 16000; // ms
const USERDATA_ERASE_TIME = 1000; // ms

// Wrapper for Entry#getData() that unwraps ProgressEvent errors
async function zipGetData(
    entry: Entry,
    writer: Writer,
    options?: EntryGetDataOptions,
) {
    try {
        return await entry.getData!(writer, options);
    } catch (e) {
        if (
            e instanceof ProgressEvent &&
            e.type === "error" &&
            e.target !== null
        ) {
            throw (e.target as any).error;
        } else {
            throw e;
        }
    }
}

async function flashEntryBlob(
    device: FastbootDevice,
    entry: Entry,
    onProgress: FactoryProgressCallback,
    partition: string
) {
    common.logDebug(`Unpacking ${partition}`);
    onProgress("unpack", partition, 0.0);
    let blob = await zipGetData(
        entry,
        new BlobWriter("application/octet-stream"),
        {
            onprogress: (bytes: number, len: number) => {
                onProgress("unpack", partition, bytes / len);
            },
        }
    );

    common.logDebug(`Flashing ${partition}`);
    onProgress("flash", partition, 0.0);
    await device.flashBlob(partition, blob, (progress) => {
        onProgress("flash", partition, progress);
    });
}

async function tryFlashImages(
    device: FastbootDevice,
    entries: Array<Entry>,
    onProgress: FactoryProgressCallback,
    imageNames: Array<string>
) {
    for (let imageName of imageNames) {
        let pattern = new RegExp(`${imageName}(?:-.+)?\\.img$`);
        let entry = entries.find((entry) => entry.filename.match(pattern));
        if (entry !== undefined) {
            await flashEntryBlob(device, entry, onProgress, imageName);
        }
    }
}

async function checkRequirements(device: FastbootDevice, androidInfo: string) {
    // Deal with CRLF just in case
    for (let line of androidInfo.replace("\r", "").split("\n")) {
        let match = line.match(/^require\s+(.+?)=(.+)$/);
        if (!match) {
            continue;
        }

        let variable = match[1];
        // Historical mismatch that we still need to deal with
        if (variable === "board") {
            variable = "product";
        }

        let expectValue = match[2];
        let expectValues: Array<string | null> = expectValue.split("|");

        // Special case: not a real variable at all
        if (variable === "partition-exists") {
            // Check whether the partition exists on the device:
            // has-slot = undefined || FAIL => doesn't exist
            // has-slot = yes || no         => exists
            let hasSlot = await device.getVariable(`has-slot:${expectValue}`);
            if (hasSlot !== "yes" && hasSlot !== "no") {
                throw new FastbootError(
                    "FAIL",
                    `Requirement ${variable}=${expectValue} failed, device lacks partition`
                );
            }

            // Check whether we recognize the partition
            if (
                !BOOT_CRITICAL_IMAGES.includes(expectValue) &&
                !SYSTEM_IMAGES.includes(expectValue)
            ) {
                throw new FastbootError(
                    "FAIL",
                    `Requirement ${variable}=${expectValue} failed, unrecognized partition`
                );
            }
        } else {
            let realValue = await device.getVariable(variable);

            if (expectValues.includes(realValue)) {
                common.logDebug(
                    `Requirement ${variable}=${expectValue} passed`
                );
            } else {
                let msg = `Requirement ${variable}=${expectValue} failed, value = ${realValue}`;
                common.logDebug(msg);
                throw new FastbootError("FAIL", msg);
            }
        }
    }
}

let lastUserdataEntry: Entry | undefined

async function tryReboot(
    device: FastbootDevice,
    target: string,
    onReconnect: ReconnectCallback
) {
    try {
        await device.reboot(target, false);
    } catch (e) {
        /* Failed = device rebooted by itself */
    }

    await device.waitForConnect(onReconnect);
}

export async function flashZip(
    device: FastbootDevice,
    blob: Blob,
    wipe: boolean,
    onReconnect: ReconnectCallback,
    onProgress: FactoryProgressCallback = (
        _action: string,
        _item: string,
        _progress: number
    )=> {}
) {
    onProgress("load", "package", 0.0);
    let reader = new ZipReader(new BlobReader(blob));
    let entries = await reader.getEntries();

    // Bootloader and radio packs can only be flashed in the bare-metal bootloader
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true, onReconnect);
    }

    // 1. Bootloader pack
    await tryFlashImages(device, entries, onProgress, ["bootloader"]);
    await common.runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        BOOTLOADER_REBOOT_TIME,
        tryReboot(device, "bootloader", onReconnect)
    );

    // 2. Radio pack
    await tryFlashImages(device, entries, onProgress, ["radio"]);
    await common.runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        BOOTLOADER_REBOOT_TIME,
        tryReboot(device, "bootloader", onReconnect)
    );

    // Cancel snapshot update if in progress
    let snapshotStatus = await device.getVariable("snapshot-update-status");
    if (snapshotStatus !== null && snapshotStatus !== "none") {
        await device.runCommand("snapshot-update:cancel");
    }

    // Load nested images for the following steps
    common.logDebug("Loading nested images from zip");
    onProgress("unpack", "images", 0.0);
    let entry = entries.find((e) => e.filename.match(/image-.+\.zip$/));
    let imagesBlob = await zipGetData(
        entry!,
        new BlobWriter("application/zip"),
        {
            onprogress: (bytes: number, len: number) => {
                onProgress("unpack", "images", bytes / len);
            },
        }
    );
    let imageReader = new ZipReader(new BlobReader(imagesBlob));
    let imageEntries = await imageReader.getEntries();

    // 3. Check requirements
    entry = imageEntries.find((e) => e.filename === "android-info.txt");
    if (entry !== undefined) {
        let reqText = await zipGetData(entry, new TextWriter());
        await checkRequirements(device, reqText);
    }

    // 4. Boot-critical images
    await tryFlashImages(
        device,
        imageEntries,
        onProgress,
        BOOT_CRITICAL_IMAGES
    );

    // 5. Super partition template
    // This is also where we reboot to fastbootd.
    entry = imageEntries.find((e) => e.filename === "super_empty.img");
    if (entry !== undefined) {
        await common.runWithTimedProgress(
            onProgress,
            "reboot",
            "device",
            FASTBOOTD_REBOOT_TIME,
            device.reboot("fastboot", true, onReconnect)
        );

        let superName = await device.getVariable("super-partition-name");
        if (!superName) {
            superName = "super";
        }

        let superAction = wipe ? "wipe" : "flash";
        onProgress(superAction, "super", 0.0);
        let superBlob = await zipGetData(
            entry,
            new BlobWriter("application/octet-stream")
        );
        await device.upload(
            superName,
            await common.readBlobAsBuffer(superBlob),
            (progress) => {
                onProgress(superAction, "super", progress);
            }
        );
        await device.runCommand(
            `update-super:${superName}${wipe ? ":wipe" : ""}`
        );
    }

    // 6. Remaining system images
    await tryFlashImages(device, imageEntries, onProgress, SYSTEM_IMAGES);

    // We unconditionally reboot back to the bootloader here if we're in fastbootd,
    // even when there's no custom AVB key, because common follow-up actions like
    // locking the bootloader and wiping data need to be done in the bootloader.
    if ((await device.getVariable("is-userspace")) === "yes") {
        await common.runWithTimedProgress(
            onProgress,
            "reboot",
            "device",
            BOOTLOADER_REBOOT_TIME,
            device.reboot("bootloader", true, onReconnect)
        );
    }

    // 7. Custom AVB key
    entry = entries.find((e) => e.filename.endsWith("avb_pkmd.bin"));
    if (entry !== undefined) {
        await device.runCommand("erase:avb_custom_key");
        await flashEntryBlob(device, entry, onProgress, "avb_custom_key");
    }

    // 8. Wipe userdata
    if (wipe) {
        await common.runWithTimedProgress(
            onProgress,
            "wipe",
            "data",
            USERDATA_ERASE_TIME,
            device.runCommand("erase:userdata")
        );
    }
}

/**
 * Type representing the images that are currently being flashed on the Almer Arc.
 */
type ArcFlashImages = {
    xblEntry: Entry,
    xblConfigEntry: Entry,
    bootEntry: Entry,
    dtboEntry: Entry,
    systemEntry: Entry,
    vendorEntry: Entry,
    vbmetaEntry: Entry,
    persistEntry: Entry,
    userdataEntry: Entry,
    modemEntry: Entry
}

/**
 * Method that takes a list of entries - representing images to flash - and checks if all the required ones are present.
 * Throws an error if any of them is missing, or returns a ArcFlashImages object if they're all present.
 * @param entries
 */
function checkExistingEntries(entries: Entry[]): ArcFlashImages {
    const xblEntry = entries.find((e) => e.filename.includes("xbl.elf"));
    console.log(`xblEntry: ${xblEntry?.filename}`);

    if (xblEntry == undefined) {
        throw new Error("xbl.elf not found in zip");
    }

    // xbl_config.elf
    const xblConfigEntry = entries.find((e) => e.filename.includes("xbl_config.elf"));
    console.log(`xblConfigEntry: ${xblConfigEntry?.filename}`);

    if (xblConfigEntry == undefined) {
        throw new Error("xbl_config.elf not found in zip");
    }

    // boot.img
    const bootEntry = entries.find((e) => e.filename.includes("boot.img"));
    console.log(`bootEntry: ${bootEntry?.filename}`);

    if (bootEntry == undefined) {
        throw new Error("boot.img not found in zip");
    }

    // dtbo.img
    const dtboEntry = entries.find((e) => e.filename.includes("dtbo.img"));
    console.log(`dtboEntry: ${dtboEntry?.filename}`);

    if (dtboEntry == undefined) {
        throw new Error("dtbo.img not found in zip");
    }

    // system.img
    const systemEntry = entries.find((e) => e.filename.includes("system.img"));
    console.log(`systemEntry: ${systemEntry?.filename}`);

    if (systemEntry == undefined) {
        throw new Error("system.img not found in zip");
    }

    // vendor.img
    const vendorEntry = entries.find((e) => e.filename.includes("vendor.img"));
    console.log(`vendorEntry: ${vendorEntry?.filename}`);

    if (vendorEntry == undefined) {
        throw new Error("vendor.img not found in zip");
    }

    // vbmeta.img
    const vbmetaEntry = entries.find((e) => e.filename.includes("vbmeta.img"));
    console.log(`vbmetaEntry: ${vbmetaEntry?.filename}`);

    if (vbmetaEntry == undefined) {
        throw new Error("vbmeta.img not found in zip");
    }

    // persist.img
    const persistEntry = entries.find((e) => e.filename.includes("persist.img"));
    console.log(`persistEntry: ${persistEntry?.filename}`);

    if (persistEntry == undefined) {
        throw new Error("persist.img not found in zip");
    }

    // userdata.img
    const userdataEntry = entries.find((e) => e.filename.includes("userdata.img"));
    console.log(`userdataEntry: ${userdataEntry?.filename}`);

    if (userdataEntry == undefined) {
        throw new Error("userdata.img not found in zip");
    }

    // modem.img
    const modemEntry = entries.find((e) => e.filename.includes("modem.img"));
    console.log(`modemEntry: ${modemEntry?.filename}`);

    if (modemEntry == undefined) {
        throw new Error("modem.img not found in zip");
    }

    return {
        xblEntry, xblConfigEntry, bootEntry, dtboEntry, systemEntry, vendorEntry, vbmetaEntry, persistEntry, userdataEntry, modemEntry
    }
}

/**
 * Method that takes the list of images, and flashes them to the target slot on the device.
 * @param device
 * @param targetSlot
 * @param arcFlashImages
 * @param onProgress
 * @param initialFlash - if you are flashing both slots, the first flash is the initial one; this ensures that userdata and persist are not flashed twice, since there is only one of each for both slots.
 */
async function flashArcSlot(
    device: FastbootDevice,
    targetSlot: '_a' | '_b',
    arcFlashImages: ArcFlashImages,
    onProgress: FactoryProgressCallback = () => {},
    initialFlash: boolean
) {
    const {
        xblEntry,
        xblConfigEntry,
        bootEntry,
        dtboEntry,
        systemEntry,
        vendorEntry,
        vbmetaEntry,
        persistEntry,
        userdataEntry,
        modemEntry
    } = arcFlashImages;

    console.log(`flashing xbl${targetSlot}`);
    await flashEntryBlob(
        device,
        xblEntry,
        onProgress,
        `xbl${targetSlot}`
    )

    console.log(`flashing xbl_config${targetSlot}`);
    await flashEntryBlob(
        device,
        xblConfigEntry,
        onProgress,
        `xbl_config${targetSlot}`
    )

    console.log(`flashing boot${targetSlot}`);
    await flashEntryBlob(
        device,
        bootEntry,
        onProgress,
        `boot${targetSlot}`
    )
    //
    console.log(`flashing dtbo${targetSlot}`);
    await flashEntryBlob(
        device,
        dtboEntry,
        onProgress,
        `dtbo${targetSlot}`
    )

    console.log(`flashing system${targetSlot}`);
    await flashEntryBlob(
        device,
        systemEntry,
        onProgress,
        `system${targetSlot}`
    )

    console.log(`flashing vendor${targetSlot}`);
    await flashEntryBlob(
        device,
        vendorEntry,
        onProgress,
        `vendor${targetSlot}`
    )

    console.log(`flashing vbmeta${targetSlot}`);
    await flashEntryBlob(
        device,
        vbmetaEntry,
        onProgress,
        `vbmeta${targetSlot}`
    )

    console.log(`flashing modem${targetSlot}`);
    await flashEntryBlob(
        device,
        modemEntry,
        onProgress,
        `modem${targetSlot}`
    )

    if (initialFlash) {
        console.log(`flashing persist`);
        await flashEntryBlob(
            device,
            persistEntry,
            onProgress,
            `persist`
        )

        console.log(`flashing userdata`);
        await flashEntryBlob(
            device,
            userdataEntry,
            onProgress,
            `userdata`
        )
        lastUserdataEntry = userdataEntry
    }
}


/**
 * Flash a zip file containing a given operating system
 * @param device fastboot device
 * @param blob zip file containing the operating system to flash (os.zip)
 * @param flashBothSlots if true, both slots will be flashed with the new os (only use when flashing over the factory image)
 * @param caseId - in order for oem.img to be created, the desired case id of the device must be specified. If undefined, the serial number of the device will not be changed.
 * @param onProgress callback for progress updates
 */
export async function flashArkZip(
    device: FastbootDevice,
    blob: Blob,
    flashBothSlots?: boolean,
    caseId?: string,
    onProgress: FactoryProgressCallback = () => {
    }
) {

    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();

    // figure out the active slot
    const activeSlot = await device.getVariable("current-slot");
    const activeSlotSuffix = activeSlot === "a" ? "_a" : "_b";

    if (activeSlot === null) {
        throw new Error("Unable to determine active slot");
    }

    const inactiveSlot = activeSlot === "a" ? "b" : "a";
    const inactiveSlotSuffix = activeSlot === "a" ? "_b" : "_a";

    console.log(`Active slot: ${activeSlot}`, "Flashing inactive slot ", inactiveSlot);

    const arcFlashImages = checkExistingEntries(entries);

    // this is the initial flash, which will override userdata and persist
    await flashArcSlot(device, inactiveSlotSuffix, arcFlashImages, onProgress, true)

    if (flashBothSlots) {
        console.log("Flashing active slot ", activeSlot);
        await flashArcSlot(device, activeSlotSuffix, arcFlashImages, onProgress, false);
    }

    // run a command to not turn on the device when it's plugged in for charging
    await device.runCommand("oem off-mode-charge 1")

    /**
     * This flag is used to signal to the frontend if the oem partition exists.
     * We try flashing it, and if it errors, then it doesn't exist, and the flag is false, and we can warn the user.
     */
    let oemExists = true;

    if (caseId) {
        const oemImage = await createImageFile(caseId);

        try {
            await device.flashBlob('oem', oemImage, (progress) => {
                onProgress("flash", 'oem', progress);
            });
        } catch {
            oemExists = false;
            console.log("oem partition does not exist on this device;");
        }
    }

    // if only one slot is flashed(inactive), then that one becomes active
    // if we flash both slots, both have the new os, changing slot is unnecessary
    if (!flashBothSlots) {
        await device.runCommand("set_active:" + inactiveSlot);
    }

    await device.reboot()

    return oemExists;
}

export async function flashLastUserData(device: FastbootDevice) {
    if (lastUserdataEntry == null) {
        throw new Error("No stored lastUserDataEntry")
    }
    await flashEntryBlob(
        device,
        lastUserdataEntry,
        () => {
        },
        `userdata`
    )
}
