/**
 * ==============================================================================
 * GOOGLE DRIVE DYNAMIC PORTFOLIO - SERVER-SIDE CODE (Code.gs)
 * ==============================================================================
 * 
 * Instructions:
 * 1. Replace 'YOUR_FOLDER_ID_HERE' below with your Google Drive Folder ID.
 *    (The folder ID is the string of letters/numbers at the end of your folder URL:
 *     https://drive.google.com/drive/folders/1a2b3c4d5e6f7g8h9...)
 * 2. Ensure your Google Drive folder is shared as "Anyone with the link can view".
 * 3. Deploy as Web App (Execute as: Me, Who has access: Anyone).
 */

// >>> GOOGLE DRIVE FOLDER ID <<<
const PORTFOLIO_FOLDER_ID = '1bIS5ekLRWkrZuQcThBdhcd6_9CPDpgcU';

// Cache expiration in seconds (default 5 minutes to prevent Drive API rate limits)
const CACHE_EXPIRATION_SECONDS = 300;

/**
 * Serves the HTML Web App
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.format === 'json') {
    const data = getPortfolioData(e.parameter.refresh === 'true');
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const template = HtmlService.createTemplateFromFile('Index');
  
  // Pass initial folder id to template if needed
  template.folderId = PORTFOLIO_FOLDER_ID;
  
  return template.evaluate()
    .setTitle('Peter Fayez — Motion Graphics & Video Portfolio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Helper to include HTML snippets (modular CSS and JS)
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Fetches portfolio data from the configured Google Drive folder.
 * Supports caching for fast performance, subfolder categorization,
 * and automatic asset type detection (Images, Videos, PDFs, Audio, Docs).
 *
 * @param {boolean} forceRefresh - If true, bypasses the cache to fetch fresh data.
 * @return {Object} Portfolio metadata, categories, and assets.
 */
function getPortfolioData(forceRefresh) {
  try {
    if (!PORTFOLIO_FOLDER_ID || PORTFOLIO_FOLDER_ID === 'YOUR_FOLDER_ID_HERE') {
      return {
        success: false,
        error: 'CONFIG_REQUIRED',
        message: 'Please specify your Google Drive Folder ID in Code.gs (PORTFOLIO_FOLDER_ID).'
      };
    }

    const rootFolder = DriveApp.getFolderById(PORTFOLIO_FOLDER_ID);
    const folderLastUpdated = rootFolder.getLastUpdated() ? rootFolder.getLastUpdated().getTime().toString() : '';
    const cache = CacheService.getScriptCache();
    const cacheKey = 'portfolio_data_' + PORTFOLIO_FOLDER_ID;
    const cacheTimeKey = 'portfolio_time_' + PORTFOLIO_FOLDER_ID;
    
    // Only return cache if forceRefresh is false AND folder timestamp has not changed
    if (!forceRefresh) {
      const cachedTime = cache.get(cacheTimeKey);
      if (cachedTime && cachedTime === folderLastUpdated) {
        const cached = cache.get(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            parsed.fromCache = true;
            return parsed;
          } catch (e) {
            // Cache parse error, proceed to fetch fresh
          }
        }
      }
    }

    const folderName = rootFolder.getName() || 'Peter Fayez';
    const folderDescription = rootFolder.getDescription() || 'Motion Graphics Designer & Video Editor | Software Engineering Student';

    let bioText = '';
    let avatarUrl = '';
    let coverUrl = '';
    const assets = [];
    const categoriesSet = new Set(['All']);

    // 1. Check root files
    scanFolderFiles(rootFolder, 'General', assets, categoriesSet, {
      onAboutFound: function(aboutContent) {
        if (aboutContent && !bioText) bioText = aboutContent;
      },
      onAvatarFound: function(url) {
        if (!avatarUrl) avatarUrl = url;
      },
      onCoverFound: function(url) {
        if (!coverUrl) coverUrl = url;
      }
    });

    // 2. Check subfolders (each subfolder acts as a project/category)
    const subfolders = rootFolder.getFolders();
    while (subfolders.hasNext()) {
      const sub = subfolders.next();
      const subName = sub.getName();
      categoriesSet.add(subName);
      scanFolderFiles(sub, subName, assets, categoriesSet, null);
    }

    // Sort items by last updated or created (newest first)
    assets.sort(function(a, b) {
      return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
    });

    // Compute stats
    const stats = {
      total: assets.length,
      images: assets.filter(item => item.type === 'image').length,
      videos: assets.filter(item => item.type === 'video').length,
      documents: assets.filter(item => item.type === 'document').length,
      audio: assets.filter(item => item.type === 'audio').length,
      others: assets.filter(item => item.type === 'other').length
    };

    const result = {
      success: true,
      author: 'Peter Fayez',
      title: 'Peter Fayez',
      folderName: folderName,
      portfolioTitle: (folderName && !/^(portfolio|cv|my portfolio|drive|files|projects)$/i.test(folderName.trim())) ? folderName : 'Peter Fayez — Motion Graphics & Video Portfolio',
      description: folderDescription,
      bio: bioText,
      avatarUrl: avatarUrl,
      coverUrl: coverUrl,
      folderId: PORTFOLIO_FOLDER_ID,
      folderUrl: rootFolder.getUrl(),
      lastSync: new Date().toISOString(),
      categories: Array.from(categoriesSet),
      stats: stats,
      items: assets,
      fromCache: false
    };

    // Store in cache (CacheService has a 100KB limit per item; guarded by folder timestamp)
    try {
      const jsonString = JSON.stringify(result);
      if (jsonString.length < 95000) {
        cache.put(cacheKey, jsonString, 1200);
        if (folderLastUpdated) {
          cache.put(cacheTimeKey, folderLastUpdated, 1200);
        }
      }
    } catch (cacheErr) {
      Logger.log('Cache storage skipped: ' + cacheErr);
    }

    return result;

  } catch (error) {
    Logger.log('Error in getPortfolioData: ' + error.toString());
    return {
      success: false,
      error: 'DRIVE_ERROR',
      message: error.toString()
    };
  }
}

/**
 * Scans files within a specific folder and appends them to the assets list.
 * Supports Google Drive Shortcuts, companion poster images for videos, and metadata.
 */
function scanFolderFiles(folder, categoryName, assets, categoriesSet, hooks) {
  const filesIter = folder.getFiles();
  const fileList = [];
  const imageMap = {}; // Maps baseName -> fileId for custom video covers
  let folderCoverId = '';

  // First pass: collect files and map potential companion posters / covers
  while (filesIter.hasNext()) {
    const f = filesIter.next();
    const fName = f.getName();
    const fLower = fName.toLowerCase();
    const fMime = f.getMimeType();

    // Check if it's an image
    if (fMime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(fLower)) {
      if (fLower === 'cover.jpg' || fLower === 'cover.png' || fLower === 'poster.jpg' || fLower === 'poster.png') {
        folderCoverId = f.getId();
      } else {
        const base = fLower.replace(/\.[^/.]+$/, '').replace(/(_thumb|_poster|_cover)$/, '');
        imageMap[base] = f.getId();
      }
    }
    fileList.push(f);
  }

  // Second pass: process assets
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const name = file.getName();
    const lowerName = name.toLowerCase();

    // Check if file is an "about" or "bio" or "readme" text file
    if (hooks && hooks.onAboutFound && (lowerName === 'about.txt' || lowerName === 'bio.txt' || lowerName === 'readme.txt')) {
      try {
        const text = file.getBlob().getDataAsString();
        hooks.onAboutFound(text);
      } catch (e) {
        // Ignore read error
      }
      continue;
    }

    // Check if file is an avatar / profile image (e.g. avatar.jpg, profile.png)
    if (hooks && hooks.onAvatarFound && (lowerName.startsWith('avatar.') || lowerName.startsWith('profile.'))) {
      hooks.onAvatarFound('https://lh3.googleusercontent.com/d/' + file.getId());
      continue;
    }

    // Check if file is a cover / banner image (e.g. cover.jpg, banner.png)
    if (hooks && hooks.onCoverFound && (lowerName.startsWith('cover.') || lowerName.startsWith('banner.'))) {
      hooks.onCoverFound('https://lh3.googleusercontent.com/d/' + file.getId());
      continue;
    }

    // Skip hidden files or system files
    if (name.startsWith('.')) {
      continue;
    }

    let fileId = file.getId();
    let mime = file.getMimeType();
    let size = file.getSize();

    // 1. Resolve Google Drive Shortcut if applicable
    if (mime === 'application/vnd.google-apps.shortcut') {
      try {
        if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.get) {
          const shortcutMeta = Drive.Files.get(fileId, { fields: 'shortcutDetails' });
          if (shortcutMeta && shortcutMeta.shortcutDetails && shortcutMeta.shortcutDetails.targetId) {
            const targetId = shortcutMeta.shortcutDetails.targetId;
            const targetFile = DriveApp.getFileById(targetId);
            fileId = targetId;
            mime = targetFile.getMimeType();
            size = targetFile.getSize();
          }
        }
      } catch (shortcutErr) {
        Logger.log('Could not resolve shortcut target for ' + name + ': ' + shortcutErr);
      }
    }

    const type = detectAssetType(mime, name);
    const cleanBase = lowerName.replace(/\.[^/.]+$/, '').replace(/(_thumb|_poster|_cover)$/, '');

    // Check for paired companion poster image
    let posterUrl = '';
    if (imageMap[cleanBase]) {
      posterUrl = 'https://lh3.googleusercontent.com/d/' + imageMap[cleanBase];
    } else if (folderCoverId) {
      posterUrl = 'https://lh3.googleusercontent.com/d/' + folderCoverId;
    }

    // Direct Google CDN for public assets
    const cdnUrl = 'https://lh3.googleusercontent.com/d/' + fileId;
    const thumbnailUrl = posterUrl || ('https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1200');
    const previewUrl = 'https://drive.google.com/file/d/' + fileId + '/preview';
    const viewUrl = file.getUrl();
    const downloadUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;

    assets.push({
      id: fileId,
      name: cleanFileName(name),
      rawName: name,
      category: categoryName,
      type: type,
      mimeType: mime,
      sizeFormatted: formatBytes(size),
      sizeBytes: size,
      created: file.getDateCreated().toISOString(),
      lastUpdated: file.getLastUpdated().toISOString(),
      thumbnailUrl: thumbnailUrl,
      posterUrl: posterUrl,
      cdnUrl: cdnUrl,
      previewUrl: previewUrl,
      viewUrl: viewUrl,
      downloadUrl: downloadUrl,
      description: file.getDescription() || ''
    });
  }
}

/**
 * Categorizes the asset type based on mime-type and file extension
 */
function detectAssetType(mime, filename) {
  const lowerName = filename.toLowerCase();
  
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|svg|bmp|avif|ico)$/i.test(lowerName)) {
    return 'image';
  }
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v|wmv|flv)$/i.test(lowerName)) {
    return 'video';
  }
  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return 'document';
  }
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(lowerName)) {
    return 'audio';
  }
  if (mime.includes('document') || mime.includes('word') || mime.includes('presentation') || 
      mime.includes('spreadsheet') || /\.(doc|docx|ppt|pptx|xls|xlsx|txt|rtf|md)$/i.test(lowerName)) {
    return 'document';
  }
  return 'other';
}

/**
 * Strips file extension for clean card display
 */
function cleanFileName(filename) {
  return filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
}

/**
 * Format bytes into human-readable string
 */
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
