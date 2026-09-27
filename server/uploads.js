/**
 * Загрузка файлов (multer). Только изображения, только в пределах uploads/.
 * После сохения дополнительно проверяем «магические» байты, а не только MIME.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { AVATAR_DIR, PHOTO_DIR } from './db.js';
import { HttpError } from './util.js';

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MAGIC = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.gif', test: (b) => b.slice(0, 3).toString('latin1') === 'GIF' },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];

function makeStorage(dir) {
  return multer.diskStorage({
    destination(req, file, cb) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename(req, file, cb) {
      const ext = MIME_EXT[file.mimetype] || '.bin';
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });
}

function fileFilter(req, file, cb) {
  if (!MIME_EXT[file.mimetype]) {
    cb(new HttpError(400, 'Поддерживаются только изображения JPG, PNG, WEBP или GIF', 'BAD_FILE'));
    return;
  }
  cb(null, true);
}

export const uploadAvatar = multer({
  storage: makeStorage(AVATAR_DIR),
  limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter,
}).single('avatar');

export const uploadPhoto = multer({
  storage: makeStorage(PHOTO_DIR),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter,
}).single('photo');

/** Проверяем сигнатуру файла и возвращаем реальное расширение. */
export function verifyImage(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    const found = MAGIC.find((m) => m.test(buf));
    return found ? found.ext : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
  }
}

export function removeUpload(dir, filename) {
  if (!filename) return;
  const target = path.join(dir, path.basename(filename));
  fs.promises.unlink(target).catch(() => {});
}

export function removeDutyPhoto(filename) {
  removeUpload(PHOTO_DIR, filename);
}

export function removeAvatar(filename) {
  removeUpload(AVATAR_DIR, filename);
}
