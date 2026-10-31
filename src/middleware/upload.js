import multer from 'multer';
import path from 'path';

// Use memory storage so we can parse directly with xlsx without disk cleanup issues
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.xlsx', '.xls', '.csv'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(ext) || 
      file.mimetype.includes('spreadsheetml') || 
      file.mimetype.includes('excel') || 
      file.mimetype.includes('csv')) {
    cb(null, true);
  } else {
    cb(new Error('Only Excel (.xlsx, .xls) and CSV (.csv) files are allowed!'), false);
  }
};

export const uploadExcel = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max file size
  fileFilter
});
