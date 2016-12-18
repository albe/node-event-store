const fs = require('fs');
const mkdirpSync = require('mkdirp').sync;
const path = require('path');

const DEFAULT_READ_BUFFER_SIZE = 4 * 1024;
const DEFAULT_WRITE_BUFFER_SIZE = 16 * 1024;

// node-event-store partition V01
const HEADER_MAGIC = "nesprt01";

class CorruptFileError extends Error {}
class InvalidDataSizeError extends Error {}

/**
 * @param {string} str
 * @param {number} len
 * @param {string} [char]
 * @returns {string}
 */
function pad(str, len, char = ' ') {
    return len > str.length ? char.repeat(len - str.length) + str : str;
}

/**
 * Method for hashing a string (partition name) to a 32-bit unsigned integer.
 *
 * @param {string} str
 * @returns {number}
 */
function hash(str) {
    if (str.length === 0) return 0;
    var hash = 5381,
        i    = str.length;

    while(i) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(--i);
    }

    /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
     * integers. Since we want the results to be always positive, convert the
     * signed int to an unsigned by doing an unsigned bitshift. */
    return hash >>> 0;
}

/**
 * A partition is a single file where the storage will write documents to depending on some partitioning rules.
 * In the case of an event store, this is most likely the (write) streams.
 */
class Partition {

    /**
     * Get the id for a specific partition name.
     *
     * @param {string} name
     * @returns {number}
     */
    static id(name) {
        return hash(name);
    }

    /**
     * Config options:
     *   - dataDirectory: The path where the storage data should reside. Default '.'.
     *   - readBufferSize: Size of the read buffer in bytes. Default 4096.
     *   - writeBufferSize: Size of the write buffer in bytes. Default 16384.
     *   - maxWriteBufferDocuments: How many documents to have in the write buffer at max. 0 means as much as possible. Default 0.
     *   - syncOnFlush: If fsync should be called on write buffer flush. Set this if you need strict durability. Defaults to false.
     *
     * @param {string} [name] The name of the partition.
     * @param {Object} [config] An object with storage parameters.
     */
    constructor(name, config = {}) {
        if (!name) {
            throw new Error('Must specify a partition name.');
        }
        this.name = name;
        this.id = hash(name);

        this.dataDirectory = path.resolve(config.dataDirectory || '.');
        if (!fs.existsSync(this.dataDirectory)) {
            mkdirpSync(this.dataDirectory);
        }

        this.fileName = path.resolve(this.dataDirectory, this.name);

        this.readBufferSize = config.readBufferSize || DEFAULT_READ_BUFFER_SIZE;
        this.writeBufferSize = config.writeBufferSize || DEFAULT_WRITE_BUFFER_SIZE;
        this.maxWriteBufferDocuments = config.maxWriteBufferDocuments || 0;
        this.syncOnFlush = !!config.syncOnFlush;
    }

    /**
     * Check if the partition file is opened.
     *
     * @returns {boolean}
     */
    isOpen() {
        return !!this.fd;
    }

    /**
     * Open the partition storage and create read and write buffers.
     *
     * @api
     * @returns {boolean}
     */
    open() {
        if (this.fd) {
            return true;
        }

        this.fd = fs.openSync(this.fileName, 'a+');

        // allocUnsafeSlow because we don't need buffer pooling for these relatively long-lived buffers
        this.readBuffer = Buffer.allocUnsafeSlow(10 + this.readBufferSize);
        // Where inside the file the read buffer starts
        this.readBufferPos = -1;

        this.writeBuffer = Buffer.allocUnsafeSlow(this.writeBufferSize);
        // Where inside the write buffer the next write is added
        this.writeBufferCursor = 0;
        // How many documents are currently in the write buffer
        this.writeBufferDocuments = 0;
        this.flushCallbacks = [];

        let stat = fs.statSync(this.fileName);
        this.headerSize = HEADER_MAGIC.length + 1;
        if (stat.size === 0) {
            fs.writeSync(this.fd, HEADER_MAGIC + "\n");
            this.size = 0;
        } else {
            let headerBuffer = Buffer.allocUnsafe(HEADER_MAGIC.length);
            fs.readSync(this.fd, headerBuffer, 0, HEADER_MAGIC.length, 0);
            if (headerBuffer.toString() !== HEADER_MAGIC) {
                this.close();
                if (headerBuffer.toString().substr(0, -2) === HEADER_MAGIC.substr(0, -2)) {
                    throw new Error('Invalid file version. The partition ' + this.name + ' was created with a different library version.');
                }
                throw new Error('Invalid file header in partition ' + this.name + '.');
            }
            this.size = stat.size - this.headerSize;
        }
        return true;
    }

    /**
     * Close the partition and frees up all resources.
     *
     * @api
     * @returns void
     */
    close() {
        if (this.fd) {
            this.flush();
            fs.closeSync(this.fd);
            this.fd = undefined;
        }
        if (this.readBuffer) {
            this.readBuffer = undefined;
            this.readBufferPos = -1;
        }
        if (this.writeBuffer) {
            this.writeBuffer = undefined;
            this.writeBufferCursor = 0;
            this.writeBufferDocuments = 0;
        }
    }

    /**
     * Flush the write buffer to disk.
     * This is a sync method and will invoke all previously registered flush callbacks.
     *
     * @private
     * @returns {boolean}
     */
    flush() {
        if (!this.fd) {
            return false;
        }
        if (this.writeBufferCursor === 0) {
            return false;
        }

        fs.writeSync(this.fd, this.writeBuffer, 0, this.writeBufferCursor);
        if (this.syncOnFlush) {
            fs.fsyncSync(this.fd);
        }

        this.writeBufferCursor = 0;
        this.writeBufferDocuments = 0;
        this.flushCallbacks.forEach(callback => callback());
        this.flushCallbacks = [];

        return true;
    }

    /**
     * @api
     * @param {string} data The data to write to storage.
     * @param {function} [callback] A function that will be called when the document is written to disk.
     * @returns {number|boolean} The file position at which the data was written or false on error.
     */
    write(data, callback) {
        if (!this.fd) {
            return false;
        }
        let dataSize = Buffer.byteLength(data, 'utf8');
        let dataToWrite = pad(dataSize.toString(), 10) + data.toString() + "\n";
        dataSize += 11;

        if (this.writeBufferCursor > 0 && dataSize + this.writeBufferCursor > this.writeBuffer.byteLength) {
            this.flush();
        }
        if (this.writeBufferCursor === 0) {
            process.nextTick(() => this.flush());
        }

        if (dataSize > this.writeBuffer.byteLength) {
            //console.log('unbuffered write!');
            fs.writeSync(this.fd, dataToWrite);
            if (typeof callback === 'function') process.nextTick(callback);
        } else {
            // We can denote ascii encoding here because dataSize is the exact byte size and the buffer is guaranteed
            // to be big enough to contain all bytes anyway. 'utf8' only checks that no characters are split.
            this.writeBufferCursor += this.writeBuffer.write(dataToWrite, this.writeBufferCursor, dataSize, 'ascii');
            this.writeBufferDocuments++;
            if (typeof callback === 'function') this.flushCallbacks.push(callback);
            if (this.maxWriteBufferDocuments > 0 && this.writeBufferDocuments >= this.maxWriteBufferDocuments) {
                this.flush();
            }
        }
        let dataPosition = this.size;
        this.size += dataSize;
        return dataPosition;
    }

    /**
     * Fill the internal read buffer starting from the given position.
     *
     * @private
     * @param {number} [from] The file position to start filling the read buffer from.
     */
    fillBuffer(from = 0) {
        if (!this.fd) {
            return;
        }
        fs.readSync(this.fd, this.readBuffer, 0, this.readBuffer.byteLength, this.headerSize + from);
        this.readBufferPos = from;
    }

    /**
     * @private
     * @param {number} position The file position to read from.
     * @param {number} [size] The expected byte size of the document at the given position.
     * @returns {string|boolean} The data stored at the given position or false if no data could be read.
     * @throws {Error} if the storage entry at the given position is corrupted.
     * @throws {Error} if the document size at the given position does not match the provided size.
     * @throws {Error} if the document at the given position can not be deserialized.
     */
    readFrom(position, size) {
        if (!this.fd) {
            return false;
        }
        if (position + 10 >= this.size) {
            return false;
        }
        let buffer = this.readBuffer;
        let bufferPos = this.readBufferPos;

        // Handle the case when data that is still in write buffer is supposed to be read
        if (this.writeBufferCursor > 0 && position >= this.size - this.writeBufferCursor) {
            buffer = this.writeBuffer;
            bufferPos = this.size - this.writeBufferCursor;
        }

        let bufferCursor = position - bufferPos;
        if (bufferPos < 0 || bufferCursor < 0 || bufferCursor + 10 > buffer.byteLength) {
            this.fillBuffer(position);
            bufferCursor = 0;
        }
        let dataPosition = bufferCursor + 10;
        let dataLengthStr = buffer.toString('utf8', bufferCursor, dataPosition);
        let dataLength = parseInt(dataLengthStr, 10);
        if (!dataLength || isNaN(dataLength) || !/^\s+[0-9]+$/.test(dataLengthStr)) {
            throw new Error('Error reading document size from ' + position + ', got ' + dataLength + '.');
        }
        if (size && dataLength !== size) {
            throw new InvalidDataSizeError('Invalid document size ' + dataLength + ' at position ' + position + ', expected ' + size + '.');
        }

        if (position + dataLength + 11 > this.size) {
            throw new CorruptFileError('Invalid document at position ' + position + '. This may be caused by an unfinished write.');
        }

        if (dataLength + 10 > buffer.byteLength) {
            //console.log('sync read for large document size', dataLength, 'at position', position);
            let tempReadBuffer = Buffer.allocUnsafe(dataLength);
            fs.readSync(this.fd, tempReadBuffer, 0, dataLength, this.headerSize + position + 10);
            return tempReadBuffer.toString('utf8');
        }

        if (bufferCursor > 0 && dataPosition + dataLength > buffer.byteLength) {
            this.fillBuffer(position);
            dataPosition = 10;
        }

        return buffer.toString('utf8', dataPosition, dataPosition + dataLength);
    }

    /**
     * @return {Generator} A generator that returns all documents in this partition.
     */
    *readAll() {
        let position = 0;
        let data;
        while (data = this.readFrom(position)) {
            yield data;
            position += Buffer.byteLength(data, 'utf8') + 11;
        }
    }

    /**
     * Truncate the partition storage at the given position.
     *
     * @param {number} after The file position after which to truncate the partition.
     */
    truncate(after) {
        if (after > this.size) {
            return;
        }
        if (after < 0) {
            after = 0;
        }
        this.flush();

        // TODO: copy all truncated documents to some delete log
        fs.truncateSync(this.fileName, this.headerSize + after);
        this.size = after;
    }
}

module.exports = Partition;
module.exports.CorruptFileError = CorruptFileError;
module.exports.InvalidDataSizeError = InvalidDataSizeError;