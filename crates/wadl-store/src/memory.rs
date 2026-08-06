//! An in-memory [`Repositories`] implementation with the demo world seeded.
//!
//! This is the working store for milestone 1. It enforces the same two gates
//! the database enforces — tenant and per-hull assignment — but in Rust, so the
//! API and the cross-tenant leak test run with no database. The seed mirrors the
//! prototype: three carriers plus a DDG and an LPD in the yard tenant, a
//! separate hull in a second (navy) tenant for the cross-tenant test, and a demo
//! identity assigned to three of the yard's five hulls so RBAC refusal is
//! visible on the other two.

use std::collections::BTreeSet;

use uuid::Uuid;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{OrgId, VesselId, WorkOrderId};
use wadl_domain::units::ManHours;

use crate::error::StoreError;
use crate::model::{
    CompartmentSummary, StrandedItem, StrandedReport, VesselSummary, WorkOrderSummary,
};
use crate::repo::Repositories;
use crate::scope::TenantScope;

struct VesselRow {
    id: VesselId,
    org: OrgId,
    hull_no: &'static str,
    name: &'static str,
    class_code: &'static str,
    availability_code: &'static str,
    confidence: &'static str,
}

struct CompartmentRow {
    vessel: VesselId,
    no: &'static str,
    name: &'static str,
    deck_code: &'static str,
    deck_ordinal: i32,
    zone: &'static str,
    category: &'static str,
}

struct WorkOrderRow {
    vessel: VesselId,
    id: WorkOrderId,
    code: &'static str,
    title: &'static str,
    trade: &'static str,
    system: &'static str,
    compartment: &'static str,
    budget: i64,
    earned: i64,
    /// A *different* compartment that must be complete before this order's work
    /// can be tested. `None` where there is no upstream dependency.
    upstream_compartment: Option<&'static str>,
    source_ref: &'static str,
    source_verified: bool,
}

/// The seeded in-memory store.
pub struct InMemoryStore {
    vessels: Vec<VesselRow>,
    compartments: Vec<CompartmentRow>,
    work_orders: Vec<WorkOrderRow>,
}

/// The identifiers of the seeded demo world, handed back so the API and tests
/// can build scopes and address specific hulls without guessing UUIDs.
#[derive(Debug, Clone)]
pub struct DemoWorld {
    /// The shipbuilder tenant that owns the five hulls.
    pub yard_org: OrgId,
    /// A second tenant (a navy) owning a separate hull, for the leak test.
    pub navy_org: OrgId,
    /// `CVN-73` — assigned to the demo identity.
    pub cvn73: VesselId,
    /// `CVN-71` — assigned to the demo identity.
    pub cvn71: VesselId,
    /// `CVN-75` — assigned to the demo identity.
    pub cvn75: VesselId,
    /// A DDG — present in the yard tenant but NOT assigned to the demo identity.
    pub ddg: VesselId,
    /// An LPD — present in the yard tenant but NOT assigned to the demo identity.
    pub lpd: VesselId,
    /// The navy tenant's hull — never visible to the yard tenant.
    pub navy_hull: VesselId,
}

const fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

impl DemoWorld {
    /// The demo yard planner's scope: the yard tenant, assigned to the three
    /// carriers only.
    #[must_use]
    pub fn yard_scope(&self) -> TenantScope {
        TenantScope::new(self.yard_org, [self.cvn73, self.cvn71, self.cvn75])
    }

    /// The navy tenant's scope, assigned to its own hull.
    #[must_use]
    pub fn navy_scope(&self) -> TenantScope {
        TenantScope::new(self.navy_org, [self.navy_hull])
    }

    /// A yard-tenant scope assigned to *every* yard hull — used to demonstrate
    /// that even full assignment never crosses the tenant boundary.
    #[must_use]
    pub fn yard_scope_all(&self) -> TenantScope {
        TenantScope::new(
            self.yard_org,
            [self.cvn73, self.cvn71, self.cvn75, self.ddg, self.lpd],
        )
    }
}

impl InMemoryStore {
    /// Builds the seeded store and returns it alongside the demo identifiers.
    #[must_use]
    pub fn demo() -> (Self, DemoWorld) {
        let world = DemoWorld {
            yard_org: OrgId::from_uuid(id(0x01)),
            navy_org: OrgId::from_uuid(id(0x02)),
            cvn73: VesselId::from_uuid(id(0x73)),
            cvn71: VesselId::from_uuid(id(0x71)),
            cvn75: VesselId::from_uuid(id(0x75)),
            ddg: VesselId::from_uuid(id(0xDD13)),
            lpd: VesselId::from_uuid(id(0x1D28)),
            navy_hull: VesselId::from_uuid(id(0x68)),
        };
        let store = Self {
            vessels: Self::seed_vessels(&world),
            compartments: Self::seed_compartments(&world),
            work_orders: Self::seed_work_orders(&world),
        };
        (store, world)
    }

    fn seed_vessels(w: &DemoWorld) -> Vec<VesselRow> {
        vec![
            VesselRow {
                id: w.cvn73,
                org: w.yard_org,
                hull_no: "CVN-73",
                name: "USS George Washington",
                class_code: "CVN-68",
                availability_code: "PIA-26",
                confidence: "At Risk",
            },
            VesselRow {
                id: w.cvn71,
                org: w.yard_org,
                hull_no: "CVN-71",
                name: "USS Theodore Roosevelt",
                class_code: "CVN-68",
                availability_code: "SRA-26",
                confidence: "On Track",
            },
            VesselRow {
                id: w.cvn75,
                org: w.yard_org,
                hull_no: "CVN-75",
                name: "USS Harry S. Truman",
                class_code: "CVN-68",
                availability_code: "DPIA-28",
                confidence: "Planning",
            },
            VesselRow {
                id: w.ddg,
                org: w.yard_org,
                hull_no: "DDG-113",
                name: "USS John Finn",
                class_code: "DDG-51 Flt IIA",
                availability_code: "DSRA-26",
                confidence: "On Track",
            },
            VesselRow {
                id: w.lpd,
                org: w.yard_org,
                hull_no: "LPD-28",
                name: "USS Fort Lauderdale",
                class_code: "LPD-17",
                availability_code: "PSA-26",
                confidence: "Planning",
            },
            VesselRow {
                id: w.navy_hull,
                org: w.navy_org,
                hull_no: "CVN-68",
                name: "USS Nimitz",
                class_code: "CVN-68",
                availability_code: "INACT-26",
                confidence: "Planning",
            },
        ]
    }

    fn seed_compartments(w: &DemoWorld) -> Vec<CompartmentRow> {
        // CVN-73 register (subset of the prototype's, enough for Deck Explorer
        // and the stranded-hours story). deck_ordinal ascends downward.
        vec![
            CompartmentRow {
                vessel: w.cvn73,
                no: "1-136-0-Q",
                name: "Hangar Bay 2",
                deck_code: "Main",
                deck_ordinal: 1,
                zone: "Z4",
                category: "Machinery / operational",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-185-0-L",
                name: "CPO Living Space",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z5",
                category: "Living",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-102-2-E",
                name: "Switchboard Room No. 1",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z2",
                category: "Electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-110-2-W",
                name: "Reserve Feed Water Tank",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z3",
                category: "Tanks & voids",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-120-4-Q",
                name: "Fan Room",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z3",
                category: "Machinery / electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-141-0-C",
                name: "Aft IC & Gyro Room",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z5",
                category: "Command & surveillance",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-149-2-Q",
                name: "Forced Draft Blower Room No. 3",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z5",
                category: "Machinery / electrical",
            },
        ]
    }

    fn seed_work_orders(w: &DemoWorld) -> Vec<WorkOrderRow> {
        // Provenance mirrors the prototype's ingest/verified stamps. The two
        // orders whose upstream_compartment points at the incomplete Aft IC &
        // Gyro Room (4-141-0-C) are the stranded ones.
        vec![
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x3318)),
                code: "WI-3318",
                title: "Reserve feed water tank preservation",
                trade: "Preservation",
                system: "506 Tanks & Voids",
                compartment: "4-110-2-W",
                budget: 680,
                earned: 512,
                upstream_compartment: None,
                source_ref: "AWR 73-26-3318",
                source_verified: true,
            },
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x3402)),
                code: "WI-3402",
                title: "Sounding & vent piping modification",
                trade: "Mechanical",
                system: "529 Drainage & Tank Level",
                compartment: "4-110-2-W",
                budget: 240,
                earned: 0,
                upstream_compartment: None,
                source_ref: "AWR 73-26-3402",
                source_verified: true,
            },
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x4471)),
                code: "WI-4471",
                title: "Hangar Bay 2 structural hot work",
                trade: "Welding",
                system: "130 Hull Decks",
                compartment: "1-136-0-Q",
                budget: 410,
                earned: 12,
                upstream_compartment: None,
                source_ref: "AWR 73-26-4471",
                source_verified: true,
            },
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x3905)),
                code: "WI-3905",
                title: "Aft IC preservation & cableway closure",
                trade: "Electrical",
                system: "431 Interior Comm",
                compartment: "4-141-0-C",
                budget: 340,
                earned: 0,
                upstream_compartment: None,
                source_ref: "AWR 73-26-3905",
                source_verified: false,
            },
            // Stranded: switchboard rip-out is ready but cannot proceed until the
            // Aft IC & Gyro Room cableway work (a different compartment) closes.
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x1905)),
                code: "WI-1905",
                title: "Switchboard No. 1 rip-out",
                trade: "Electrical",
                system: "322 Power Distribution",
                compartment: "4-102-2-E",
                budget: 160,
                earned: 0,
                upstream_compartment: Some("4-141-0-C"),
                source_ref: "AWR 73-26-1905",
                source_verified: false,
            },
            // Stranded: fan-room duct insulation waits on the same upstream room.
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x5571)),
                code: "WI-5571",
                title: "Fan room duct insulation",
                trade: "Preservation",
                system: "512 Ventilation & Uptakes",
                compartment: "4-120-4-Q",
                budget: 140,
                earned: 0,
                upstream_compartment: Some("4-141-0-C"),
                source_ref: "AWR 73-26-5571",
                source_verified: true,
            },
        ]
    }

    /// Resolves a hull under `scope`, applying tenant then assignment. Every
    /// scoped query funnels through here so the two gates are enforced once.
    fn scoped_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<&VesselRow, StoreError> {
        self.vessels
            .iter()
            .find(|v| v.id == vessel && v.org == scope.org && scope.is_assigned(vessel))
            .ok_or(StoreError::NotFound)
    }

    fn compartment_complete(&self, vessel: VesselId, compartment: &str) -> bool {
        // Complete when every work order in the compartment has earned its full
        // budget. A compartment with no orders is trivially complete.
        self.work_orders
            .iter()
            .filter(|w| w.vessel == vessel && w.compartment == compartment)
            .all(|w| w.earned >= w.budget)
    }
}

fn summarise_vessel(v: &VesselRow) -> VesselSummary {
    VesselSummary {
        vessel_id: v.id,
        hull_no: v.hull_no.to_owned(),
        name: v.name.to_owned(),
        class_code: v.class_code.to_owned(),
        availability_code: v.availability_code.to_owned(),
        confidence: v.confidence.to_owned(),
    }
}

impl Repositories for InMemoryStore {
    fn list_vessels(&self, scope: &TenantScope) -> Vec<VesselSummary> {
        self.vessels
            .iter()
            .filter(|v| v.org == scope.org && scope.is_assigned(v.id))
            .map(summarise_vessel)
            .collect()
    }

    fn get_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<VesselSummary, StoreError> {
        self.scoped_vessel(scope, vessel).map(summarise_vessel)
    }

    fn list_compartments(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<CompartmentSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self
            .compartments
            .iter()
            .filter(|c| c.vessel == vessel)
            .map(|c| CompartmentSummary {
                compartment_no: CompartmentNo::new(c.no),
                name: c.name.to_owned(),
                deck_code: c.deck_code.to_owned(),
                deck_ordinal: c.deck_ordinal,
                zone: c.zone.to_owned(),
                category: c.category.to_owned(),
            })
            .collect())
    }

    fn list_work_orders(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<WorkOrderSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self
            .work_orders
            .iter()
            .filter(|w| w.vessel == vessel)
            .map(|w| WorkOrderSummary {
                work_order_id: w.id,
                code: w.code.to_owned(),
                title: w.title.to_owned(),
                trade: w.trade.to_owned(),
                system: w.system.to_owned(),
                compartment_no: CompartmentNo::new(w.compartment),
                budget_hours: ManHours::new(w.budget),
                earned_hours: ManHours::new(w.earned),
                source_ref: w.source_ref.to_owned(),
                source_verified: w.source_verified,
            })
            .collect())
    }

    fn stranded_hours(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<StrandedReport, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        let mut items: Vec<StrandedItem> = Vec::new();
        let mut seen: BTreeSet<(&str, &str)> = BTreeSet::new();
        for order in self.work_orders.iter().filter(|w| w.vessel == vessel) {
            let Some(upstream) = order.upstream_compartment else {
                continue;
            };
            let remaining = order.budget - order.earned;
            if remaining <= 0 || upstream == order.compartment {
                continue;
            }
            if self.compartment_complete(vessel, upstream) {
                continue;
            }
            // De-duplicate on (blocked, blocker) so two orders in the same
            // compartment blocked by the same room aggregate cleanly.
            if seen.insert((order.compartment, upstream)) {
                items.push(StrandedItem {
                    compartment_no: CompartmentNo::new(order.compartment),
                    hours: ManHours::new(remaining),
                    blocked_by: CompartmentNo::new(upstream),
                });
            } else if let Some(existing) = items
                .iter_mut()
                .find(|i| i.compartment_no.as_str() == order.compartment)
            {
                existing.hours = existing.hours + ManHours::new(remaining);
            }
        }
        let total = items.iter().map(|i| i.hours).sum();
        Ok(StrandedReport { total, items })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_gate_hides_unassigned_hulls() {
        let (store, w) = InMemoryStore::demo();
        let scope = w.yard_scope();
        // Three assigned carriers are visible.
        assert_eq!(store.list_vessels(&scope).len(), 3);
        // The unassigned DDG is NotFound even though it is in-tenant.
        assert!(matches!(
            store.get_vessel(&scope, w.ddg),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn tenant_gate_hides_other_tenants_hull() {
        let (store, w) = InMemoryStore::demo();
        // Even assigned to every yard hull, the yard never sees the navy hull.
        assert!(matches!(
            store.get_vessel(&w.yard_scope_all(), w.navy_hull),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn stranded_hours_are_cross_compartment_only() {
        let (store, w) = InMemoryStore::demo();
        let report = store.stranded_hours(&w.yard_scope(), w.cvn73).unwrap();
        // WI-1905 (160) + WI-5571 (140), both blocked by 4-141-0-C.
        assert_eq!(report.total, ManHours::new(300));
        assert_eq!(report.items.len(), 2);
        assert!(report
            .items
            .iter()
            .all(|i| i.blocked_by.as_str() == "4-141-0-C"));
    }
}
