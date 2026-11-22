"use client";
import { useEffect, useState } from "react";
import type { TeamCommand } from "../../merchant-team/contracts";
type Api = <T>(command:TeamCommand)=>Promise<T>;

function applicationKey(encoded:string) {
  const binary=atob(encoded.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(encoded.length/4)*4,"="));
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
export function PhoneAlerts({api}:{api:Api}) {
  const [message,setMessage]=useState("");
  const [active,setActive]=useState(false);
  const [busy,setBusy]=useState(false);
  const [duty,setDuty]=useState<"primary"|"backup">("primary");
  const [location,setLocation]=useState("");
  useEffect(()=>{
    if(!("serviceWorker" in navigator)||!("PushManager" in window))return;
    let cancelled=false;
    void navigator.serviceWorker.register("/refund-alert-sw.js")
      .then(registration=>registration.pushManager.getSubscription())
      .then(subscription=>{if(!cancelled)setActive(Boolean(subscription));})
      .catch(()=>{if(!cancelled)setMessage("This browser could not prepare phone alerts.");});
    return()=>{cancelled=true;};
  },[]);
  async function enable() {
    setBusy(true);setMessage("");
    try {
      if(!("PushManager" in window)||!("Notification" in window))throw Error("Use a browser that supports Web Push. On iPhone, add ChangeGate to the Home Screen first.");
      if(await Notification.requestPermission()!=="granted")throw Error("Notifications are disabled for this device.");
      const {publicKey}=await api<{publicKey:string|null}>({action:"refundAlertSettings"});
      if(!publicKey)throw Error("Push delivery is not configured.");
      const registration=await navigator.serviceWorker.ready;
      const existing=await registration.pushManager.getSubscription();
      const subscription=existing??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(publicKey)});
      const {endpoint,keys}=subscription.toJSON();
      try {
        if(!endpoint||!keys?.p256dh||!keys.auth)throw Error("This browser did not supply a usable push subscription.");
        await api({action:"enrollRefundAlerts",enrollment:{endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth},duty,location}});
      } catch(e) {
        if(!existing)await subscription.unsubscribe();
        throw e;
      }
      setActive(true);setMessage("This device is on duty for 12 hours.");
    }catch(e){setMessage(e instanceof Error?e.message:"Could not turn on alerts.");}
    finally{setBusy(false);}
  }
  async function disable() {
    setBusy(true);setMessage("");
    try{
      const registration=await navigator.serviceWorker.getRegistration();
      const subscription=await registration?.pushManager.getSubscription();
      if(subscription){
        await api({action:"removeRefundAlerts",endpoint:subscription.endpoint});
        await subscription.unsubscribe();
      }
      setActive(false);setMessage("This device is off duty.");
    }catch(e){setMessage(e instanceof Error?e.message:"Could not turn off alerts.");}
    finally{setBusy(false);}
  }
  return <details>
    <summary>Phone alerts</summary>
    <p>Get alerts while the queue is closed. On iPhone, open ChangeGate from the Home Screen.</p>
    <label>On-duty role<select value={duty} onChange={e=>setDuty(e.target.value==="backup"?"backup":"primary")}>
      <option value="primary">Primary supervisor</option><option value="backup">Backup supervisor</option>
    </select></label>
    <label>Alert location<select value={location} onChange={e=>setLocation(e.target.value)}>
      <option value="">All locations</option><option>Harbor Fuel</option><option>Harbor Bar</option>
    </select></label>
    <button type="button" disabled={busy} onClick={()=>void enable()}>{active?"Renew or update phone alerts":"Turn on phone alerts"}</button>
    {active&&<button type="button" disabled={busy} onClick={()=>void disable()}>Turn off phone alerts</button>}
    <p role="status">{message}</p>
  </details>;
}
