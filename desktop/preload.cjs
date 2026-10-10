const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sideraDesktop',Object.freeze({
 approveReview:(reviewId)=>ipcRenderer.invoke('desktop:approve-review',reviewId),
 saveApiCredential:(credentialRef,key)=>ipcRenderer.invoke('desktop:save-api-credential',credentialRef,key),
 openProduct:(adapter)=>ipcRenderer.invoke('desktop:open-product',adapter),
 copyReport:(text)=>ipcRenderer.invoke('desktop:copy-report',text),
 exportReport:(text)=>ipcRenderer.invoke('desktop:export-report',text),
 diagnostics:()=>ipcRenderer.invoke('desktop:diagnostics'),
 openDataFolder:()=>ipcRenderer.invoke('desktop:open-data'),
 exportDiagnostics:()=>ipcRenderer.invoke('desktop:export-diagnostics'),
 updateStatus:()=>ipcRenderer.invoke('desktop:update-status'),
 openHostGuide:(adapter)=>ipcRenderer.invoke('desktop:host-guide',adapter),
 checkUpdates:()=>ipcRenderer.invoke('desktop:update-check'),
 downloadUpdate:()=>ipcRenderer.invoke('desktop:update-download'),
 installUpdate:()=>ipcRenderer.invoke('desktop:update-install'),
 openChat:(bindingId)=>ipcRenderer.invoke('desktop:open-chat',bindingId),
 openFallback:()=>ipcRenderer.invoke('desktop:fallback')
}));
