let currentDbName = '/_savedata'; 
const STORE_NAME = 'FILE_DATA';

// Elements
const statusElement = document.getElementById('statusMessage');
const uploadArea = document.getElementById('uploadArea');
const fileUploadInput = document.getElementById('fileUploadInput');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const searchFilter = document.getElementById('searchFilter');
const dbSelector = document.getElementById('dbSelector');

let currentSortColumn = 'date';
let currentSortDirection = 'desc';
let allFilesCache = [];
let selectedFiles = new Set();

// Modals
const deleteModal = document.getElementById('deleteModal');
const renameModal = document.getElementById('renameModal');
const deleteAllModal = document.getElementById('deleteAllModal');
const finalDeleteAllModal = document.getElementById('finalDeleteAllModal');
const deleteSelectedModal = document.getElementById('deleteSelectedModal');
const createDbModal = document.getElementById('createDbModal');
const deleteDbModal = document.getElementById('deleteDbModal');
let filePathToModify = null;

// --- UTILS ---
function setStatus(text, type = 'info') {
    statusElement.textContent = text;
    statusElement.style.color = type === 'success' ? '#1e8e3e' : type === 'error' ? '#d93025' : '#333';
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function updateBatchActionsUI() {
    const batchBar = document.getElementById('batchActionsBar');
    const selectionCountEl = document.getElementById('selectionCount');
    const numSelected = selectedFiles.size;

    if (numSelected > 0) {
        batchBar.classList.add('visible');
        selectionCountEl.textContent = `${numSelected} file${numSelected > 1 ? 's' : ''} selected`;
    } else {
        batchBar.classList.remove('visible');
    }

    const visiblePaths = allFilesCache.filter(file => !file.hidden).map(f => f.fullPath);
    if (numSelected === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (visiblePaths.length > 0 && numSelected === visiblePaths.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }
}

// --- DATABASE MANAGEMENT ---

async function refreshDatabaseList() {
    try {
        // Fallback for browsers without databases() support (though most modern ones have it)
        if (!indexedDB.databases) {
            console.warn("indexedDB.databases() not supported.");
            dbSelector.innerHTML = `<option value="${currentDbName}">${currentDbName}</option>`;
            return;
        }

        const dbs = await indexedDB.databases();
        dbSelector.innerHTML = '';
        
        let foundCurrent = false;
        // Filter out non-app DBs if necessary, but here we show all.
        // We can sort them to keep things tidy.
        dbs.sort((a, b) => a.name.localeCompare(b.name));

        if (dbs.length === 0) {
            // If no DBs exist at all, just show the default one we will create
            const opt = document.createElement('option');
            opt.value = currentDbName;
            opt.textContent = currentDbName;
            dbSelector.appendChild(opt);
        } else {
            dbs.forEach(db => {
                const option = document.createElement('option');
                option.value = db.name;
                option.textContent = db.name;
                if (db.name === currentDbName) {
                    option.selected = true;
                    foundCurrent = true;
                }
                dbSelector.appendChild(option);
            });
            
            // If the current DB (e.g., just created) isn't in the list yet for some reason, add it
            if (!foundCurrent) {
                const option = document.createElement('option');
                option.value = currentDbName;
                option.textContent = currentDbName;
                option.selected = true;
                dbSelector.appendChild(option);
            }
        }
    } catch (e) {
        console.error("Error listing databases:", e);
        setStatus("Could not list databases.", "error");
    }
}

async function createDatabase(name) {
    if (!name) return;
    setStatus(`Creating database ${name}...`, 'info');
    try {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = (e) => {
            e.target.result.close();
            currentDbName = name;
            refreshDatabaseList().then(() => {
                // Manually set select because refresh might not pick it up instantly if empty
                dbSelector.value = currentDbName; 
                fetchAndDisplaySaveFiles();
                setStatus(`Database ${name} created and selected.`, 'success');
            });
        };
        req.onerror = (e) => {
            throw new Error(e.target.error.message);
        };
    } catch (error) {
        setStatus(`Failed to create database: ${error.message}`, 'error');
    }
}

async function deleteDatabase(name) {
    setStatus(`Deleting database ${name}...`, 'info');
    try {
        await new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
            req.onblocked = () => {
                // If blocked, it means a connection is still open (likely ours)
                // We should have closed it in performDbAction or elsewhere, but let's warn.
                console.warn("Delete blocked. Closing connections...");
            };
        });
        
        setStatus(`Database ${name} deleted.`, 'success');
        
        // Switch to default or find another one
        if (name === '/_savedata') {
            // If we deleted the default, just recreate it empty
            currentDbName = '/_savedata';
            await ensureDbInitialized(); 
        } else {
            // Switch to default
            currentDbName = '/_savedata';
        }
        
        await refreshDatabaseList();
        dbSelector.value = currentDbName;
        await fetchAndDisplaySaveFiles();
        
    } catch (error) {
        setStatus(`Failed to delete database: ${error.message}`, 'error');
    }
}

// --- FILE OPERATIONS ---

function renderTable() {
    const tbody = document.getElementById('saveFilesTbody');
    tbody.innerHTML = '';

    const searchTerm = searchFilter.value.toLowerCase();
    let visibleFileCount = 0;
    const filesToRender = allFilesCache.filter(file => {
         const isVisible = file.name.toLowerCase().includes(searchTerm);
         file.hidden = !isVisible;
         if(isVisible) visibleFileCount++;
         return isVisible;
    });

    filesToRender.sort((a, b) => {
        if (currentSortColumn === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true });
        if (currentSortColumn === 'size') return a.size - b.size;
        return a.date - b.date;
    });
    if (currentSortDirection === 'desc') filesToRender.reverse();

    if (allFilesCache.length === 0) {
         tbody.innerHTML = `<tr class="message-row"><td colspan="5">No save files found in ${currentDbName}.</td></tr>`;
    } else if (visibleFileCount === 0) {
        tbody.innerHTML = `<tr class="message-row"><td colspan="5">No matching files found.</td></tr>`;
    } else {
        filesToRender.forEach(file => {
            const isSelected = selectedFiles.has(file.fullPath);
            const row = tbody.insertRow();
            if (isSelected) row.classList.add('selected');
            row.innerHTML = `
                <td><input type="checkbox" class="row-checkbox" data-path="${file.fullPath}" ${isSelected ? 'checked' : ''}></td>
                <td>${file.name}</td>
                <td>${formatBytes(file.size)}</td>
                <td>${file.date.toLocaleString()}</td>
                <td class="actions-cell">
                    <button class="action-btn download-btn" data-path="${file.fullPath}">Download</button>
                    <button class="action-btn rename-btn" data-path="${file.fullPath}">Rename</button>
                    <button class="action-btn replace-btn" data-path="${file.fullPath}">Replace</button>
                    <button class="action-btn delete-btn" data-path="${file.fullPath}">Delete</button>
                    <input type="file" class="hidden-file-input" data-path="${file.fullPath}" />
                </td>
            `;
        });
    }
    updateBatchActionsUI();
}

async function fetchAndDisplaySaveFiles() {
    const headers = document.querySelectorAll('#saveFilesTable thead th');
    headers.forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sortBy === currentSortColumn) {
            th.classList.add(currentSortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
    });

    try {
        const db = await new Promise((res, rej) => indexedDB.open(currentDbName).onsuccess = e => res(e.target.result));
        
        // Handle case where DB exists but store doesn't (weird state, but possible)
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            allFilesCache = [];
            renderTable();
            db.close();
            return;
        }
        
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const fileList = [];
        await new Promise(resolve => {
            store.openCursor().onsuccess = e => {
                const cursor = e.target.result;
                if (cursor) {
                    fileList.push({
                        fullPath: String(cursor.key),
                        name: String(cursor.key).split('/').pop(),
                        date: cursor.value.timestamp ? new Date(cursor.value.timestamp) : new Date(),
                        size: cursor.value.contents ? cursor.value.contents.length : 0,
                        hidden: false
                    });
                    cursor.continue();
                } else resolve();
            };
        });
        db.close();
        allFilesCache = fileList;
        renderTable();
    } catch (error) {
        // If DB doesn't exist or can't be opened
        console.warn(`Could not open ${currentDbName}, maybe it was deleted or doesn't exist yet.`, error);
        allFilesCache = [];
        renderTable();
    }
}

async function performDbAction(action, mode = 'readwrite') {
     return new Promise(async (resolve, reject) => {
        const db = await new Promise((res, rej) => indexedDB.open(currentDbName).onsuccess = e => res(e.target.result));
        
        if (!db.objectStoreNames.contains(STORE_NAME)) {
             db.close();
             return reject(new Error(`Store ${STORE_NAME} not found in ${currentDbName}`));
        }

        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        action(store, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
        transaction.oncomplete = () => db.close();
        transaction.onerror = e => reject(e.target.error);
        transaction.onabort = e => reject(e.target.error);
    });
}

async function ensureDbInitialized() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(currentDbName);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = (e) => {
            e.target.result.close();
            resolve();
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

const deleteSingleFile = filePath => performDbAction((store, cb) => store.delete(filePath).onsuccess = () => cb());
const deleteAllFiles = () => performDbAction((store, cb) => store.clear().onsuccess = () => cb());
const writeFileToDB = async (filePath, file) => {
    await ensureDbInitialized(); 
    const arrayBuffer = await file.arrayBuffer();
    const dataToStore = { timestamp: new Date(), mode: 33206, contents: new Int8Array(arrayBuffer) };
    return performDbAction((store, cb) => store.put(dataToStore, filePath).onsuccess = () => cb());
};

async function renameFile(oldPath, newName) {
    const newPath = `${currentDbName}/${newName}`;
    if (oldPath === newPath) return; 
    
    return performDbAction((store, callback) => {
        const getNewReq = store.get(newPath);
        getNewReq.onsuccess = () => {
            if (getNewReq.result) {
                return callback(new Error(`A file named "${newName}" already exists.`));
            }
            const getOldReq = store.get(oldPath);
            getOldReq.onsuccess = () => {
                const data = getOldReq.result;
                if (!data) return callback(new Error('Original file not found.'));
                data.timestamp = new Date(); 
                store.put(data, newPath).onsuccess = () => {
                    store.delete(oldPath).onsuccess = () => callback(null, 'Success');
                };
            };
        };
    });
}

async function handleFileUpload(file) {
    if (!file) return setStatus('No file provided for upload.', 'error');
    const filePath = `${currentDbName}/${file.name}`;
    setStatus(`Uploading ${file.name} to ${currentDbName}...`, 'info');
    try {
        await writeFileToDB(filePath, file);
        setStatus(`Successfully uploaded and saved ${file.name}!`, 'success');
        await fetchAndDisplaySaveFiles();
        fileUploadInput.value = "";
    } catch (error) { setStatus(`Upload Error: ${error.message}`, 'error'); }
}

async function downloadFile(filePath) {
    try {
         const db = await new Promise((res, rej) => indexedDB.open(currentDbName).onsuccess = e => res(e.target.result));
         const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(filePath);
        await new Promise((resolve, reject) => {
            request.onerror = e => reject(`Could not read file: ${e.target.error}`);
            request.onsuccess = e => {
                const fileData = e.target.result;
                if (!fileData || !fileData.contents) return reject('File data not found.');
                const blob = new Blob([fileData.contents], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = Object.assign(document.createElement('a'), { href: url, download: filePath.split('/').pop() });
                document.body.appendChild(a).click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                resolve();
            };
        });
        db.close();
        setStatus(`Downloaded ${filePath.split('/').pop()}`, 'success');
    } catch(error) { setStatus(`Download failed: ${error}`, 'error'); }
}

// --- EVENT LISTENERS ---

// DB Switcher
dbSelector.addEventListener('change', async (e) => {
    currentDbName = e.target.value;
    setStatus(`Switched to database: ${currentDbName}`, 'info');
    selectedFiles.clear();
    selectAllCheckbox.checked = false;
    await ensureDbInitialized();
    await fetchAndDisplaySaveFiles();
});

// DB Create
document.getElementById('createDbBtn').addEventListener('click', () => {
    createDbModal.style.display = 'flex';
    document.getElementById('newDbNameInput').focus();
});

// DB Delete
document.getElementById('deleteDbBtn').addEventListener('click', () => {
    document.getElementById('dbToDeleteName').textContent = currentDbName;
    deleteDbModal.style.display = 'flex';
});

// DB Modals
function setupModal(modal, onConfirm) {
    modal.addEventListener('click', async (event) => {
        const target = event.target;
        const confirmBtn = modal.querySelector('.confirm-btn');
        if (target.matches('.cancel-btn') || target === modal) {
            modal.style.display = 'none';
            // Clear inputs if any
            const input = modal.querySelector('input');
            if(input) input.value = '';
            filePathToModify = null;
        } else if (target.matches('.confirm-btn') && !confirmBtn.disabled && !confirmBtn.classList.contains('loading')) {
            confirmBtn.classList.add('loading');
            try {
                await onConfirm();
            } finally {
                confirmBtn.classList.remove('loading');
                modal.style.display = 'none';
                const input = modal.querySelector('input');
                if(input) input.value = '';
            }
        }
    });
}

setupModal(createDbModal, async () => {
    const name = document.getElementById('newDbNameInput').value.trim();
    if (!name) throw new Error("Name cannot be empty");
    await createDatabase(name);
});

setupModal(deleteDbModal, async () => {
    await deleteDatabase(currentDbName);
});

// Search & Sort
searchFilter.addEventListener('input', renderTable);
document.querySelector('#saveFilesTable thead').addEventListener('click', event => {
    const th = event.target.closest('th[data-sort-by]');
    if (!th) return;
    const sortBy = th.dataset.sortBy;
    currentSortDirection = (sortBy === currentSortColumn && currentSortDirection === 'asc') ? 'desc' : 'asc';
    currentSortColumn = sortBy;
    fetchAndDisplaySaveFiles();
});

// Selection
selectAllCheckbox.addEventListener('change', () => {
    const visiblePaths = allFilesCache.filter(f => !f.hidden).map(f => f.fullPath);
    if (selectAllCheckbox.checked) {
        visiblePaths.forEach(path => selectedFiles.add(path));
    } else {
        visiblePaths.forEach(path => selectedFiles.delete(path));
    }
    renderTable();
});

document.getElementById('saveFilesTbody').addEventListener('change', event => {
    if (!event.target.matches('.row-checkbox')) return;
    const { path } = event.target.dataset;
    if (event.target.checked) selectedFiles.add(path); else selectedFiles.delete(path);
    event.target.closest('tr').classList.toggle('selected', event.target.checked);
    updateBatchActionsUI();
});

// Table Actions
document.getElementById('refreshBtn').addEventListener('click', async () => {
    setStatus('Refreshing file list...', 'info');
    await fetchAndDisplaySaveFiles();
    await refreshDatabaseList(); // Also refresh DB list in case external changes happened
    setStatus('File list updated.', 'success');
});

document.getElementById('saveFilesTbody').addEventListener('click', event => {
    const target = event.target.closest('button.action-btn');
    if (!target) return;
    const { path } = target.dataset;
    filePathToModify = path;
    const fileName = path.split('/').pop();
    
    if (target.classList.contains('download-btn')) downloadFile(path);
    else if (target.classList.contains('replace-btn')) target.closest('td').querySelector('.hidden-file-input').click();
    else if (target.classList.contains('delete-btn')) {
        deleteModal.querySelector('#fileToDeleteName').textContent = fileName;
        deleteModal.style.display = 'flex';
    } else if (target.classList.contains('rename-btn')) {
        renameModal.querySelector('#originalFileName').textContent = fileName;
        renameModal.querySelector('#newFileNameInput').value = fileName;
        renameModal.style.display = 'flex';
        renameModal.querySelector('#newFileNameInput').focus();
    }
});

// File Inputs
document.getElementById('saveFilesTbody').addEventListener('change', async event => {
    const target = event.target;
    if (!target.matches('input[type="file"].hidden-file-input')) return;
    const selectedFile = target.files[0];
    if (!selectedFile) return;
    const filePath = target.dataset.path;
    setStatus(`Replacing ${filePath.split('/').pop()}...`, 'info');
    try {
        await writeFileToDB(filePath, selectedFile);
        setStatus(`Successfully replaced ${filePath.split('/').pop()}!`, 'success');
        await fetchAndDisplaySaveFiles();
    } catch (error) { setStatus(`Error replacing file: ${error.message}`, 'error'); } 
    finally { target.value = ''; }
});

// File Modals
setupModal(deleteModal, async () => {
    const fileName = filePathToModify.split('/').pop();
    setStatus(`Deleting ${fileName}...`, 'info');
    try { await deleteSingleFile(filePathToModify); setStatus(`Successfully deleted ${fileName}!`, 'success'); selectedFiles.delete(filePathToModify); await fetchAndDisplaySaveFiles(); }
    catch (error) { setStatus(`Error deleting ${fileName}: ${error.message}`, 'error'); }
});

setupModal(renameModal, async () => {
    const newName = document.getElementById('newFileNameInput').value.trim();
    const oldName = filePathToModify.split('/').pop();
    if (!newName || newName === oldName) return;
    setStatus(`Renaming ${oldName} to ${newName}...`, 'info');
    try { await renameFile(filePathToModify, newName); setStatus('File renamed successfully!', 'success'); selectedFiles.delete(filePathToModify); await fetchAndDisplaySaveFiles(); }
    catch (error) { setStatus(`Rename failed: ${error.message}`, 'error'); }
});

setupModal(deleteSelectedModal, async () => { const num = selectedFiles.size; setStatus(`Deleting ${num} files...`, 'info'); try { await Promise.all([...selectedFiles].map(p => deleteSingleFile(p))); setStatus(`Successfully deleted ${num} files!`, 'success'); selectedFiles.clear(); await fetchAndDisplaySaveFiles(); } catch (error) { setStatus(`Error deleting files: ${error.message}`, 'error'); } });
document.getElementById('deleteAllBtn').addEventListener('click', () => deleteAllModal.style.display = 'flex');
setupModal(deleteAllModal, async () => { deleteAllModal.style.display = 'none'; finalDeleteAllModal.style.display = 'flex'; document.getElementById('finalDeleteConfirmationInput').focus() });
document.getElementById('finalDeleteConfirmationInput').addEventListener('input', e => document.getElementById('finalConfirmDeleteAllBtn').disabled = e.target.value !== 'DELETE');
setupModal(finalDeleteAllModal, async () => { if(document.getElementById('finalConfirmDeleteAllBtn').disabled) return; setStatus('Deleting all files...', 'info'); try { await deleteAllFiles(); setStatus('Successfully deleted all files!', 'success'); selectedFiles.clear(); await fetchAndDisplaySaveFiles(); } catch (error) { setStatus(`Error deleting files: ${error.message}`, 'error'); } });

// Batch Actions
document.getElementById('deleteSelectedBtn').addEventListener('click', () => { const n = selectedFiles.size; if (n === 0) return; document.getElementById('deleteSelectedCount').textContent = `${n} file${n > 1 ? 's' : ''}`; deleteSelectedModal.style.display = 'flex'; });

document.getElementById('downloadSelectedBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const n = selectedFiles.size;
    if (n === 0 || typeof JSZip === 'undefined') return;
    
    button.classList.add('loading');
    setStatus(`Zipping ${n} files...`, 'info');
    
    try {
        const zip = new JSZip();
        const fileContents = await performDbAction((store, cb) => {
            Promise.all([...selectedFiles].map(p => new Promise((res) => store.get(p).onsuccess = e => res(e.target.result))))
                   .then(results => cb(null, results));
        }, 'readonly');

        fileContents.forEach((fileData, index) => {
            if (fileData && fileData.contents) {
                const path = [...selectedFiles][index];
                zip.file(path.split('/').pop(), fileData.contents.buffer);
            }
        });

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const a = Object.assign(document.createElement('a'), { href: url, download: 'selected-saves.zip' });
        document.body.appendChild(a).click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus(`Downloaded ${n} files!`, 'success');
    } catch (error) {
        setStatus(`Failed to create zip: ${error.message}`, 'error');
    } finally {
        button.classList.remove('loading');
    }
});

// Upload
document.getElementById('uploadBtn').addEventListener('click', () => handleFileUpload(fileUploadInput.files[0]));
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => uploadArea.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }));
['dragenter', 'dragover'].forEach(e => uploadArea.addEventListener(e, () => uploadArea.classList.add('dragover')));
['dragleave', 'drop'].forEach(e => uploadArea.addEventListener(e, () => uploadArea.classList.remove('dragover')));
uploadArea.addEventListener('drop', e => handleFileUpload(e.dataTransfer.files[0]));

document.getElementById('downloadZipBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (typeof JSZip === 'undefined') return setStatus('JSZip library is missing.', 'error');

    button.classList.add('loading');
    setStatus('Preparing ZIP file...', 'info');

    try {
        const zip = new JSZip();
        await performDbAction((store, cb) => {
            store.openCursor().onsuccess = e => {
                const cursor = e.target.result;
                if (cursor) {
                    if (cursor.value && cursor.value.contents) {
                        zip.file(String(cursor.key).split('/').pop(), cursor.value.contents.buffer);
                    }
                    cursor.continue();
                } else cb(null);
            };
        }, 'readonly');

        if (Object.keys(zip.files).length === 0) {
            setStatus('No files found to download.', 'info');
            return; 
        }
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const a = Object.assign(document.createElement('a'), { href: url, download: 'save-data.zip' });
        document.body.appendChild(a).click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus('ZIP file download initiated!', 'success');
    } catch (error) {
        setStatus(`Failed to create zip file: ${error.message}`, 'error');
    } finally {
        button.classList.remove('loading');
    }
});

// INIT
(async () => {
    await ensureDbInitialized();
    await refreshDatabaseList();
    fetchAndDisplaySaveFiles();
})();