export * from "../../core/bus.ts";
import { deliverMessage as real } from "../../core/bus.ts";
import { guardMocks } from "./execution.ts";
export const deliverMessage:typeof real=(db,id,hythes)=>real(db,id,guardMocks(hythes));
