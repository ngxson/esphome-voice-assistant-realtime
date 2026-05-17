import fs from 'fs';
import path from 'path';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export class WavRecorder {
  private stream: fs.WriteStream;
  private dataBytes = 0;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath);
    this.writePlaceholderHeader();
  }

  private writePlaceholderHeader(): void {
    const byteRate = SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE / 8;
    const blockAlign = NUM_CHANNELS * BITS_PER_SAMPLE / 8;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(0, 4);           // placeholder: file size - 8
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);         // fmt chunk size
    header.writeUInt16LE(1, 20);          // PCM format
    header.writeUInt16LE(NUM_CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(0, 40);          // placeholder: data chunk size

    this.stream.write(header);
  }

  write(pcmData: Buffer): void {
    this.stream.write(pcmData);
    this.dataBytes += pcmData.length;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => {
        // Patch the size fields now that we know the totals
        const fd = fs.openSync(this.filePath, 'r+');
        const buf = Buffer.alloc(4);

        buf.writeUInt32LE(36 + this.dataBytes, 0);
        fs.writeSync(fd, buf, 0, 4, 4);

        buf.writeUInt32LE(this.dataBytes, 0);
        fs.writeSync(fd, buf, 0, 4, 40);

        fs.closeSync(fd);
        resolve();
      });
    });
  }
}
