import { controlHost as real } from "../../core/host-control.ts";
import { guardMocks } from "./execution.ts";
export const controlHost:typeof real=(db,hythes,caller,input)=>real(db,guardMocks(hythes),caller,input);
