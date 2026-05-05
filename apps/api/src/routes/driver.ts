/**
 * /v1/driver/* — endpoints scoped to the authenticated driver. All routes
 * mounted here go through the `driverAuth` middleware (verifies Supabase
 * JWT, resolves to drivers row), so handlers can trust c.get("driverId")
 * and c.get("orgId") to be the actual driver's identity.
 */
import { Hono } from "hono";
import { driverAuth, type DriverAuthVariables } from "../middleware/driverAuth.js";

const driver = new Hono<{ Variables: DriverAuthVariables }>();

driver.use("*", driverAuth);

driver.get("/me", (c) => {
  return c.json({
    driverId:   c.get("driverId"),
    orgId:      c.get("orgId"),
    name:       c.get("driverName"),
    phone:      c.get("phone"),
  });
});

export default driver;
