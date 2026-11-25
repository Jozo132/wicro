/**
 * Host-independent ELF32, Unix `ar`, ESP32-C3 image generation/validation, and
 * Clang diagnostic/completion parsers.
 * Uses only standard Web APIs (`Uint8Array`, `DataView`, `TextDecoder`,
 * `crypto.subtle`) so it runs identically in Node.js, browsers, and Web Workers.
 */

const asciiDecoder = new TextDecoder('latin1');
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Compute a SHA-256 digest using the native Web Crypto API.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export const sha256Digest = async (bytes) => {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is unavailable in this runtime');
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest);
};

/**
 * Extract a member object from a Unix `ar` archive purely in JavaScript.
 * @param {Uint8Array} archive
 * @param {string} memberPrefix
 * @returns {Uint8Array}
 */
export const extractArchiveMember = (archive, memberPrefix) => {
  if (archive.length < 8 || asciiDecoder.decode(archive.subarray(0, 8)) !== '!<arch>\n') {
    throw new Error('Invalid ar archive header');
  }
  let offset = 8;
  while (offset + 60 <= archive.length) {
    const rawName = asciiDecoder.decode(archive.subarray(offset, offset + 16)).trim();
    const size = Number.parseInt(asciiDecoder.decode(archive.subarray(offset + 48, offset + 58)).trim(), 10);
    const dataOffset = offset + 60;
    if (!Number.isFinite(size) || size < 0 || dataOffset + size > archive.length) {
      throw new Error(`Corrupt ar member header at offset ${offset}`);
    }
    if (rawName.startsWith(memberPrefix)) {
      const copy = new Uint8Array(size);
      copy.set(archive.subarray(dataOffset, dataOffset + size));
      return copy;
    }
    offset = dataOffset + size + (size & 1);
  }
  throw new Error(`Archive member '${memberPrefix}' not found`);
};

/**
 * Set ELF32 section header flags (e.g. SHF_ALLOC | SHF_EXECINSTR = 0x6) on a named section.
 * @param {Uint8Array} objectBytes
 * @param {string} sectionName
 * @param {number} flagsToSet
 * @returns {Uint8Array}
 */
export const patchElfSectionFlags = (objectBytes, sectionName, flagsToSet) => {
  const output = new Uint8Array(objectBytes.length);
  output.set(objectBytes);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  if (output.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
    throw new Error('Invalid ELF32 object');
  }
  const shoff = view.getUint32(32, true);
  const shent = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  const shstrndx = view.getUint16(50, true);
  const strOff = view.getUint32(shoff + shstrndx * shent + 16, true);

  for (let index = 0; index < shnum; index++) {
    const offset = shoff + index * shent;
    const nameIndex = view.getUint32(offset, true);
    let end = strOff + nameIndex;
    while (end < output.length && output[end] !== 0) end++;
    const name = utf8Decoder.decode(output.subarray(strOff + nameIndex, end));
    if (name === sectionName) {
      const currentFlags = view.getUint32(offset + 8, true);
      view.setUint32(offset + 8, currentFlags | flagsToSet, true);
    }
  }
  return output;
};

/**
 * Convert a RISC-V ESP32-C3 ELF32 image into an official Espressif application
 * binary with section-based segment merging, 64 KB MMU page alignment for DROM
 * and IROM segments, RAM segment splitting/zero-padding, app_elf_sha256
 * population, XOR checksum, and appended SHA-256 digest.
 * @param {Uint8Array} elf
 * @returns {Promise<Uint8Array>}
 */
export const elfToEsp32Bin = async (elf) => {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
    throw new Error('Invalid ELF32 image');
  }
  if (view.getUint32(20, true) !== 1) {
    throw new Error('ESP32 ELF is not a supported ELF version');
  }

  const machine = view.getUint16(18, true);
  if (machine !== 243) throw new Error(`Expected RISC-V ELF, got e_machine=${machine}`);

  const entry = view.getUint32(24, true);
  const sectionOffset = view.getUint32(32, true);
  const sectionEntrySize = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true);

  /** @type {Array<{addr:number,data:Uint8Array}>} */
  const rawSections = [];
  if (sectionOffset > 0 && sectionEntrySize >= 40 && sectionCount > 0) {
    for (let index = 0; index < sectionCount; index++) {
      const offset = sectionOffset + index * sectionEntrySize;
      if (offset + 40 > elf.length) break;
      const type = view.getUint32(offset + 4, true);
      const flags = view.getUint32(offset + 8, true);
      const addr = view.getUint32(offset + 12, true);
      const fileOffset = view.getUint32(offset + 16, true);
      const size = view.getUint32(offset + 20, true);
      if (type === 8 || (flags & 2) === 0 || size === 0 || addr === 0) continue;
      if (fileOffset + size > elf.length) throw new Error(`ELF section ${index} extends beyond the file`);
      rawSections.push({ addr, data: elf.subarray(fileOffset, fileOffset + size) });
    }
  }

  if (rawSections.length === 0) {
    const programOffset = view.getUint32(28, true);
    const programEntrySize = view.getUint16(42, true);
    const programCount = view.getUint16(44, true);
    for (let index = 0; index < programCount; index++) {
      const offset = programOffset + index * programEntrySize;
      if (offset + 32 > elf.length) break;
      const type = view.getUint32(offset, true);
      const fileOffset = view.getUint32(offset + 4, true);
      const addr = view.getUint32(offset + 12, true);
      const fileSize = view.getUint32(offset + 16, true);
      if (type !== 1 || fileSize === 0 || addr === 0) continue;
      if (fileOffset + fileSize > elf.length) throw new Error(`ELF segment ${index} extends beyond the file`);
      rawSections.push({ addr, data: elf.subarray(fileOffset, fileOffset + fileSize) });
    }
  }

  if (rawSections.length === 0) throw new Error('ELF image has no loadable ESP32 segments');

  rawSections.sort((left, right) => left.addr - right.addr);

  /** @type {Array<{addr:number,data:Uint8Array}>} */
  const merged = [];
  for (const section of rawSections) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      section.addr >= previous.addr + previous.data.length &&
      section.addr - (previous.addr + previous.data.length) < 16
    ) {
      const gap = section.addr - (previous.addr + previous.data.length);
      const combined = new Uint8Array(previous.data.length + gap + section.data.length);
      combined.set(previous.data, 0);
      combined.set(section.data, previous.data.length + gap);
      previous.data = combined;
    } else {
      merged.push({ addr: section.addr, data: new Uint8Array(section.data) });
    }
  }

  /** @param {Uint8Array} data */
  const pad4 = (data) => {
    const aligned = (data.length + 3) & ~3;
    if (aligned === data.length) return data;
    const padded = new Uint8Array(aligned);
    padded.set(data);
    return padded;
  };

  /** @param {number} addr */
  const isFlashMapped = (addr) =>
    (addr >= 0x3c000000 && addr < 0x3c800000) ||
    (addr >= 0x42000000 && addr < 0x42800000);

  const flashSegments = merged
    .filter((segment) => isFlashMapped(segment.addr))
    .map((segment) => ({ addr: segment.addr, data: pad4(segment.data) }));
  const ramSegments = merged
    .filter((segment) => !isFlashMapped(segment.addr))
    .map((segment) => ({ addr: segment.addr, data: pad4(segment.data) }));

  const dromSegment = flashSegments.find((segment) => segment.addr >= 0x3c000000 && segment.addr < 0x3c800000);
  if (dromSegment && dromSegment.data.length >= 0xb0) {
    const dromView = new DataView(dromSegment.data.buffer, dromSegment.data.byteOffset, dromSegment.data.byteLength);
    if (dromView.getUint32(0, true) === 0xabcd5432) {
      const elfSha = await sha256Digest(elf);
      dromSegment.data.set(elfSha, 0x90);
    }
  }

  const IROM_ALIGN = 0x10000;
  /** @type {Array<{addr:number,data:Uint8Array}>} */
  const outputSegments = [];
  let filePos = 24;

  /** @param {{addr:number,data:Uint8Array}} segment */
  const emit = (segment) => {
    outputSegments.push(segment);
    filePos += 8 + segment.data.length;
  };

  for (const flashSegment of flashSegments) {
    const targetOffset = flashSegment.addr & (IROM_ALIGN - 1);
    const currentOffset = (filePos + 8) & (IROM_ALIGN - 1);
    let padNeeded = (targetOffset - currentOffset) & (IROM_ALIGN - 1);
    while (padNeeded > 0) {
      if (padNeeded < 8) padNeeded += IROM_ALIGN;
      if (ramSegments.length > 0) {
        const ramSegment = ramSegments[0];
        const totalSize = 8 + ramSegment.data.length;
        if (totalSize <= padNeeded) {
          emit(/** @type {{addr:number,data:Uint8Array}} */ (ramSegments.shift()));
          padNeeded -= totalSize;
          continue;
        }
        const take = (padNeeded - 8) & ~3;
        if (take > 0) {
          emit({ addr: ramSegment.addr, data: ramSegment.data.subarray(0, take) });
          ramSegment.addr += take;
          ramSegment.data = ramSegment.data.subarray(take);
          padNeeded -= (8 + take);
          continue;
        }
      }
      emit({ addr: 0, data: new Uint8Array(padNeeded - 8) });
      padNeeded = 0;
    }
    emit(flashSegment);
  }

  while (ramSegments.length > 0) {
    emit(/** @type {{addr:number,data:Uint8Array}} */ (ramSegments.shift()));
  }

  if (outputSegments.length > 16) throw new Error(`ELF image has too many segments (${outputSegments.length})`);

  const header = new Uint8Array(24);
  const headerView = new DataView(header.buffer);
  header[0] = 0xe9;
  header[1] = outputSegments.length;
  header[2] = 2; // DIO
  header[3] = 0x2f; // 4 MB, 80 MHz
  headerView.setUint32(4, entry, true);
  header[8] = 0xee; // wp_pin disabled
  headerView.setUint16(12, 5, true); // ESP32-C3 chip_id
  header[17] = 0xff; // max_chip_rev_full low byte
  header[18] = 0xff; // max_chip_rev_full high byte
  header[23] = 1; // SHA-256 appended

  /** @type {Uint8Array[]} */
  const chunks = [header];
  let checksum = 0xef;
  for (const segment of outputSegments) {
    const segmentHeader = new Uint8Array(8);
    const segmentView = new DataView(segmentHeader.buffer);
    segmentView.setUint32(0, segment.addr, true);
    segmentView.setUint32(4, segment.data.length, true);
    chunks.push(segmentHeader, segment.data);
    for (const byte of segment.data) checksum = (checksum ^ byte) & 0xff;
  }

  const unalignedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const checksumOffset = unalignedLength + (15 - (unalignedLength % 16));
  const digestOffset = checksumOffset + 1;

  const output = new Uint8Array(digestOffset + 32);
  let writeOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  output[checksumOffset] = checksum;

  const digest = await sha256Digest(output.subarray(0, digestOffset));
  output.set(digest, digestOffset);

  return output;
};

/**
 * Convert an ELF32 image to either an Espressif ESP32-C3 application binary
 * (for RISC-V) or a flat raw flash binary (for ARM Cortex-M).
 * @param {Uint8Array} elf
 * @returns {Promise<Uint8Array>}
 */
export const elfToBin = async (elf) => {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) throw new Error('Invalid ELF image');
  const machine = view.getUint16(18, true);
  if (machine === 243) return elfToEsp32Bin(elf);

  const sectionOffset = view.getUint32(32, true);
  const sectionEntrySize = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true);
  if (sectionOffset === 0 || sectionEntrySize < 40 || sectionCount === 0) throw new Error('ELF image has no section table');

  // Section VMAs can point into RAM while their initializers are stored in
  // flash. Use PT_LOAD physical addresses to locate those bytes in the image.
  const programOffset = view.getUint32(28, true);
  const programEntrySize = view.getUint16(42, true);
  const programCount = view.getUint16(44, true);
  /** @type {{offset:number,size:number,address:number}[]} */
  const loads = [];
  if (programCount && programEntrySize < 32) throw new Error('Invalid ELF program table');
  for (let index = 0; index < programCount; index++) {
    const offset = programOffset + index * programEntrySize;
    if (offset + 32 > elf.length) throw new Error('Truncated ELF program table');
    if (view.getUint32(offset, true) === 1) loads.push({ offset: view.getUint32(offset + 4, true), address: view.getUint32(offset + 12, true), size: view.getUint32(offset + 16, true) });
  }
  /** @type {{address:number,fileOffset:number,size:number}[]} */
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const offset = sectionOffset + index * sectionEntrySize;
    if (offset + 40 > elf.length) throw new Error('Truncated ELF section table');
    let address = view.getUint32(offset + 12, true);
    const fileOffset = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const type = view.getUint32(offset + 4, true);
    const flags = view.getUint32(offset + 8, true);
    if (type === 8 || (flags & 2) === 0 || !size) continue;
    if (fileOffset + size > elf.length) throw new Error('Truncated ELF section contents');
    const load = loads.find((segment) => fileOffset >= segment.offset && fileOffset + size <= segment.offset + segment.size);
    if (load) address = load.address + fileOffset - load.offset;
    if (address < 0x08000000 || address >= 0x20000000) continue;
    if (address + size > 0x20000000) throw new Error('ELF section crosses flash address space');
    sections.push({ address, fileOffset, size });
  }
  if (!sections.length) throw new Error('ELF image has no flash sections');
  const start = Math.min(...sections.map((section) => section.address));
  const end = Math.max(...sections.map((section) => section.address + section.size));
  if (end - start > 64 * 1024 * 1024) throw new Error('ELF flash image contains an excessive address gap');
  const bin = new Uint8Array(end - start);
  for (const { address, fileOffset, size } of sections) bin.set(elf.subarray(fileOffset, fileOffset + size), address - start);
  return bin;
};

/**
 * Independent parser and validator for Espressif ESP32-C3 application images.
 * Checks magic, chip ID, entry point, segment table, 64 KB MMU alignment of
 * DROM/IROM segments, esp_app_desc_t magic, XOR checksum, and SHA-256 digest.
 * @param {Uint8Array} image
 * @returns {Promise<{valid:boolean,errors:string[],entry:number,chipId:number,segmentCount:number,hasAppDesc:boolean,checksum:number,expectedChecksum:number,sha256Valid:boolean,segments:Array<{index:number,loadAddr:number,length:number,fileOffset:number,mapped:boolean}>}>}
 */
export const validateEsp32Image = async (image) => {
  /** @type {string[]} */
  const errors = [];
  if (image.length < 24 + 1 + 32) {
    return { valid: false, errors: ['Image too small for ESP32 header, checksum, and SHA-256'], entry: 0, chipId: 0, segmentCount: 0, hasAppDesc: false, checksum: 0, expectedChecksum: 0, sha256Valid: false, segments: [] };
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const magic = image[0];
  const segmentCount = image[1];
  const entry = view.getUint32(4, true);
  const chipId = view.getUint16(12, true);
  const hashAppended = image[23];

  if (magic !== 0xe9) errors.push(`Invalid ESP32 image magic: 0x${magic.toString(16)} (expected 0xe9)`);
  if (segmentCount === 0 || segmentCount > 16) errors.push(`Invalid segment count: ${segmentCount}`);
  if (chipId !== 5) errors.push(`Unexpected chip_id: ${chipId} (expected 5 for ESP32-C3)`);
  if (entry < 0x4037c000 || entry >= 0x403e0000) errors.push(`Entry point 0x${entry.toString(16)} is outside ESP32-C3 IRAM`);

  let offset = 24;
  let computedChecksum = 0xef;
  let hasAppDesc = false;
  /** @type {Array<{index:number,loadAddr:number,length:number,fileOffset:number,mapped:boolean}>} */
  const segments = [];

  for (let index = 0; index < segmentCount; index++) {
    if (offset + 8 > image.length) {
      errors.push(`Truncated segment header at index ${index}`);
      break;
    }
    const loadAddr = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + length > image.length) {
      errors.push(`Segment ${index} payload (0x${length.toString(16)} bytes) extends past EOF`);
      break;
    }
    if ((length & 3) !== 0) {
      errors.push(`Segment ${index} length ${length} is not 4-byte aligned`);
    }
    const isDrom = loadAddr >= 0x3c000000 && loadAddr < 0x3c800000;
    const isIrom = loadAddr >= 0x42000000 && loadAddr < 0x42800000;
    const mapped = isDrom || isIrom;
    if (mapped && ((dataOffset & 0xffff) !== (loadAddr & 0xffff))) {
      errors.push(
        `Flash-mapped segment ${index} at 0x${loadAddr.toString(16)} has misaligned file offset 0x${dataOffset.toString(16)} ` +
        `((fileOff & 0xffff)=0x${(dataOffset & 0xffff).toString(16)} != (loadAddr & 0xffff)=0x${(loadAddr & 0xffff).toString(16)})`
      );
    }
    if (isDrom && length >= 4 && view.getUint32(dataOffset, true) === 0xabcd5432) {
      hasAppDesc = true;
    }
    for (let byteIndex = 0; byteIndex < length; byteIndex++) {
      computedChecksum = (computedChecksum ^ image[dataOffset + byteIndex]) & 0xff;
    }
    segments.push({ index, loadAddr, length, fileOffset: dataOffset, mapped });
    offset = dataOffset + length;
  }

  const checksumOffset = offset + (15 - (offset % 16));
  const expectedChecksum = checksumOffset < image.length ? image[checksumOffset] : -1;
  if (checksumOffset >= image.length) {
    errors.push('Image truncated before checksum byte');
  } else if (computedChecksum !== expectedChecksum) {
    errors.push(`Checksum mismatch: computed 0x${computedChecksum.toString(16)}, stored 0x${expectedChecksum.toString(16)}`);
  }

  let sha256Valid = false;
  if (hashAppended === 1) {
    const digestOffset = checksumOffset + 1;
    if (digestOffset + 32 !== image.length) {
      errors.push(`Expected 32-byte SHA-256 at 0x${digestOffset.toString(16)}, image size is 0x${image.length.toString(16)}`);
    } else {
      const actualDigest = await sha256Digest(image.subarray(0, digestOffset));
      const storedDigest = image.subarray(digestOffset, digestOffset + 32);
      sha256Valid = actualDigest.length === storedDigest.length && actualDigest.every((value, idx) => value === storedDigest[idx]);
      if (!sha256Valid) errors.push('SHA-256 digest mismatch');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    entry,
    chipId,
    segmentCount,
    hasAppDesc,
    checksum: computedChecksum,
    expectedChecksum,
    sha256Valid,
    segments
  };
};

/**
 * Inspect ELF32 section sizes for memory statistics (text/flash, data, bss).
 * @param {Uint8Array} elf
 */
export const inspectElfMemoryStats = (elf) => {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
    return { textBytes: 0, rodataBytes: 0, dataBytes: 0, bssBytes: 0, totalFlashBytes: 0, totalRamBytes: 0 };
  }
  const shoff = view.getUint32(32, true);
  const shent = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  let textBytes = 0;
  let rodataBytes = 0;
  let dataBytes = 0;
  let bssBytes = 0;

  for (let i = 0; i < shnum; i++) {
    const pos = shoff + i * shent;
    if (pos + 40 > elf.length) break;
    const type = view.getUint32(pos + 4, true);
    const flags = view.getUint32(pos + 8, true);
    const size = view.getUint32(pos + 20, true);
    if ((flags & 2) === 0 || size === 0) continue; // SHF_ALLOC
    if (type === 8) { // SHT_NOBITS
      bssBytes += size;
    } else if ((flags & 4) !== 0) { // SHF_EXECINSTR
      textBytes += size;
    } else if ((flags & 1) !== 0) { // SHF_WRITE
      dataBytes += size;
    } else {
      rodataBytes += size;
    }
  }

  return {
    textBytes,
    rodataBytes,
    dataBytes,
    bssBytes,
    totalFlashBytes: textBytes + rodataBytes + dataBytes,
    totalRamBytes: dataBytes + bssBytes
  };
};

/**
 * Parse Clang/LLD diagnostic lines into structured diagnostic objects,
 * including endColumn extracted from Clang's caret/tilde underline when present.
 * @param {string} text
 */
export const parseClangDiagnostics = (text) => {
  /** @type {Array<{severity:'error'|'warning'|'info',file:string,line:number,column:number,endColumn?:number,message:string}>} */
  const diagnostics = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s*(.*)$/);
    if (!match) continue;
    const severity = match[4] === 'warning' ? 'warning' : match[4] === 'note' ? 'info' : 'error';
    const column = Number(match[3]);
    /** @type {number | undefined} */
    let endColumn;
    // Clang prints: [source line] followed by [spaces + ^~~~ underline]
    const caretLine = lines[index + 2];
    if (caretLine && /^\s*[~^]+\s*$/.test(caretLine)) {
      const spanMatch = caretLine.match(/[~^]+/);
      if (spanMatch && spanMatch.index !== undefined) {
        const spanStart = spanMatch.index + 1;
        const spanEnd = spanStart + spanMatch[0].length;
        if (spanEnd > column) endColumn = spanEnd;
      }
    }
    diagnostics.push({
      severity,
      file: match[1],
      line: Number(match[2]),
      column,
      ...(endColumn ? { endColumn } : {}),
      message: match[5]
    });
  }
  return diagnostics;
};

/**
 * Parse Clang `-code-completion-at` output into completion candidates.
 * @param {string} text
 */
export const parseCodeCompletion = (text) => {
  /** @type {Array<{label:string,detail:string}>} */
  const candidates = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^COMPLETION:\s*([^\s]+)(?:\s+:\s*(.*))?$/);
    if (match) candidates.push({ label: match[1], detail: match[2] ?? '' });
  }
  return candidates;
};
