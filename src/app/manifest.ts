import type { MetadataRoute } from "next";
export default function manifest():MetadataRoute.Manifest {
  return {
    id:"/transactions",
    name:"ChangeGate",
    short_name:"ChangeGate",
    start_url:"/transactions",
    scope:"/",
    display:"standalone",
    background_color:"#edf2f6",
    theme_color:"#00685e",
  };
}
