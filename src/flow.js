// 流转模块：管理事项 / 预约的状态流转与浏览器存档（localStorage）。
// 所有写操作都先过规则模块校验，失败时返回错误信息且数据原样不动。

import {
  ACTIVE_STATUSES,
  findActiveAppointment,
  isActive,
  prepareBatch,
  validateDoingReschedule
} from "./rules.js";

const STORAGE_KEY = "zfl-14-repairs";

function uid() {
  return crypto.randomUUID();
}

function isoDaysFromNow(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function seedState() {
  const leak = {
    id: uid(),
    location: "厨房",
    title: "水槽下方渗水",
    priority: "high",
    cost: 260,
    status: "todo",
    photo: "",
    note: "先检查软管接口"
  };
  const lock = {
    id: uid(),
    location: "入户门",
    title: "门锁松动开合异响",
    priority: "medium",
    cost: 150,
    status: "todo",
    photo: "",
    note: "需要十字螺丝刀"
  };
  const light = {
    id: uid(),
    location: "卫生间",
    title: "顶灯接触不良",
    priority: "low",
    cost: 120,
    status: "todo",
    photo: "",
    note: ""
  };
  const heater = {
    id: uid(),
    location: "阳台",
    title: "热水器保养清洗",
    priority: "medium",
    cost: 300,
    status: "doing",
    photo: "",
    note: "王师傅已到场处理"
  };

  return {
    filter: "all",
    repairs: [leak, lock, light, heater],
    appointments: [
      {
        id: uid(),
        repairId: heater.id,
        date: isoDaysFromNow(0),
        start: 10,
        end: 12,
        worker: "王师傅",
        status: "arrived",
        cancelReason: "",
        createdAt: new Date().toISOString()
      },
      {
        id: uid(),
        repairId: lock.id,
        date: isoDaysFromNow(1),
        start: 14,
        end: 16,
        worker: "李师傅",
        status: "booked",
        cancelReason: "",
        createdAt: new Date().toISOString()
      }
    ]
  };
}

function migrate(state) {
  return {
    filter: state.filter || "all",
    repairs: Array.isArray(state.repairs) ? state.repairs : [],
    appointments: Array.isArray(state.appointments) ? state.appointments : []
  };
}

export function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return migrate(JSON.parse(saved));
    } catch {
      // 存档损坏时退回初始数据。
    }
  }
  return seedState();
}

export function createStore(initialState) {
  let state = initialState;

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function mutate(fn) {
    const snapshot = JSON.stringify(state);
    let result;
    try {
      result = fn(state);
    } catch (error) {
      return { ok: false, errors: [String(error.message || error)] };
    }
    // 规则不通过时一律不落库：恢复整批/整单操作前的快照。
    if (result && result.ok === false) {
      state = JSON.parse(snapshot);
      return result;
    }
    persist();
    return { ok: true, ...(result || {}) };
  }

  return {
    getState: () => state,
    persist,
    setFilter(filter) {
      state.filter = filter;
      persist();
      return { ok: true };
    },

    addRepair(data) {
      return mutate((draft) => {
        draft.repairs.unshift({
          id: uid(),
          location: data.location,
          title: data.title,
          priority: data.priority,
          cost: Number(data.cost || 0),
          status: "todo",
          photo: data.photo,
          note: data.note
        });
      });
    },

    deleteRepair(repairId) {
      return mutate((draft) => {
        draft.repairs = draft.repairs.filter((repair) => repair.id !== repairId);
        // 连带清掉该事项的所有预约（含已取消记录）。
        draft.appointments = draft.appointments.filter(
          (appointment) => appointment.repairId !== repairId
        );
      });
    },

    // 批量排期：规则模块统一校验，任何一行有问题都整批退回。
    bookBatch(rows) {
      return mutate((draft) => {
        const { errors, entries } = prepareBatch(rows, draft);
        if (errors.length) return { ok: false, errors };
        const now = new Date().toISOString();
        entries.forEach((entry) => {
          draft.appointments.push({
            id: uid(),
            repairId: entry.repairId,
            date: entry.date,
            start: entry.start,
            end: entry.end,
            worker: entry.worker,
            status: "booked",
            cancelReason: "",
            createdAt: now
          });
        });
        return { count: entries.length };
      });
    },

    // 到场：预约转为 arrived，事项同步进入处理中。
    markArrived(repairId) {
      return mutate((draft) => {
        const repair = draft.repairs.find((item) => item.id === repairId);
        const appointment = findActiveAppointment(draft.appointments, repairId);
        if (!repair || !appointment) return { ok: false, errors: ["找不到该事项的生效预约"] };
        if (appointment.status === "arrived") return { ok: false, errors: ["师傅已到场"] };
        appointment.status = "arrived";
        repair.status = "doing";
      });
    },

    // 取消未到场预约：必须写缘由，取消后时段立即让出。
    cancelBooking(appointmentId, reason) {
      return mutate((draft) => {
        const appointment = draft.appointments.find((item) => item.id === appointmentId);
        if (!appointment) return { ok: false, errors: ["找不到该预约"] };
        if (!isActive(appointment)) return { ok: false, errors: ["该预约不在可取消状态"] };
        if (appointment.status === "arrived") {
          return { ok: false, errors: ["师傅已到场，不能按未到场预约取消"] };
        }
        const trimmed = String(reason || "").trim();
        if (!trimmed) return { ok: false, errors: ["取消预约必须写明缘由"] };
        appointment.status = "cancelled";
        appointment.cancelReason = trimmed;
        const repair = draft.repairs.find((item) => item.id === appointment.repairId);
        if (repair && repair.status === "todo") repair.status = "todo";
      });
    },

    // 处理中事项改期：不得推到已排待到场事项之后。
    rescheduleDoing(input) {
      return mutate((draft) => {
        const { errors, self, candidate } = validateDoingReschedule(input, draft);
        if (errors.length) return { ok: false, errors };
        self.date = candidate.date;
        self.start = candidate.start;
        self.end = candidate.end;
        self.worker = candidate.worker;
      });
    },

    // 完成：事项 done，到场预约释放为 completed。
    completeRepair(repairId) {
      return mutate((draft) => {
        const repair = draft.repairs.find((item) => item.id === repairId);
        if (!repair) return { ok: false, errors: ["找不到该事项"] };
        if (repair.status !== "doing") return { ok: false, errors: ["只有处理中的事项可以完成"] };
        repair.status = "done";
        const appointment = findActiveAppointment(draft.appointments, repairId);
        if (appointment) appointment.status = "completed";
      });
    },

    activeStatuses: ACTIVE_STATUSES
  };
}
