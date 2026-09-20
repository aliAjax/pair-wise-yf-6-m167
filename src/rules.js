// 规则模块：只负责业务规则与纯计算，不碰 DOM、不改数据。
// 排期以「日期 + 两小时时段 + 师傅」为基本单位。

export const SLOT_START_HOURS = [8, 10, 12, 14, 16, 18];

// booked：已排期、等待到场；arrived：师傅已到场（事项处理中）；
// cancelled：已取消（时段释放）；completed：事项完成（时段释放）。
export const ACTIVE_STATUSES = ["booked", "arrived"];

export function isValidSlotStart(start) {
  return SLOT_START_HOURS.includes(Number(start));
}

export function isActive(appointment) {
  return ACTIVE_STATUSES.includes(appointment.status);
}

export function findActiveAppointment(appointments, repairId) {
  return appointments.find((item) => item.repairId === repairId && isActive(item)) || null;
}

// 同一位师傅、同一天、时间段交叠即撞车（首尾相接不算交叠）。
export function overlaps(a, b) {
  return (
    a.date === b.date &&
    String(a.worker).trim() === String(b.worker).trim() &&
    Number(a.start) < Number(b.end) &&
    Number(b.start) < Number(a.end)
  );
}

// 仍可排期的事项：待处理且手上没有生效中的预约。
export function schedulableRepairs(repairs, appointments) {
  return repairs.filter(
    (repair) => repair.status === "todo" && !findActiveAppointment(appointments, repair.id)
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function slotRangeText(start) {
  return `${pad2(Number(start))}:00-${pad2(Number(start) + 2)}:00`;
}

function repairCaption(repairs, repairId) {
  const repair = repairs.find((item) => item.id === repairId);
  return repair ? `${repair.location}·${repair.title}` : "已删除的事项";
}

// 整批校验：任一行字段不全、状态不符或时段撞车，都返回完整错误清单。
// 只有错误清单为空时，调用方才允许落库，保证「整批退回、原样不动」。
export function prepareBatch(rows, ctx) {
  const errors = [];
  const entries = [];
  const rowByRepair = new Map();

  rows.forEach((raw, index) => {
    const rowNo = index + 1;
    const repairId = String(raw.repairId ?? "").trim();
    const date = String(raw.date ?? "").trim();
    const worker = String(raw.worker ?? "").trim();
    const start =
      raw.start === "" || raw.start === null || raw.start === undefined
        ? null
        : Number(raw.start);

    const missing = [];
    if (!repairId) missing.push("维修事项");
    if (!date) missing.push("日期");
    if (start === null || Number.isNaN(start)) missing.push("时段");
    if (!worker) missing.push("师傅");
    if (missing.length) {
      errors.push(`第 ${rowNo} 行字段不全：缺少 ${missing.join("、")}`);
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`第 ${rowNo} 行日期格式不正确`);
      return;
    }
    if (!isValidSlotStart(start)) {
      errors.push(`第 ${rowNo} 行时段不在可选的两小时时段内`);
      return;
    }

    const repair = ctx.repairs.find((item) => item.id === repairId);
    if (!repair) {
      errors.push(`第 ${rowNo} 行选择的事项不存在`);
      return;
    }
    if (repair.status !== "todo") {
      errors.push(`第 ${rowNo} 行「${repairCaption(ctx.repairs, repairId)}」不是待处理事项`);
      return;
    }
    if (findActiveAppointment(ctx.appointments, repairId)) {
      errors.push(`第 ${rowNo} 行「${repairCaption(ctx.repairs, repairId)}」已有生效中的排期`);
      return;
    }
    if (rowByRepair.has(repairId)) {
      errors.push(
        `第 ${rowNo} 行与第 ${rowByRepair.get(repairId)} 行重复选择了同一事项`
      );
      return;
    }
    rowByRepair.set(repairId, rowNo);

    entries.push({ rowNo, repairId, date, start, end: start + 2, worker });
  });

  entries.forEach((entry) => {
    const clashInBatch = entries.find((other) => other !== entry && overlaps(entry, other));
    if (clashInBatch) {
      errors.push(
        `第 ${entry.rowNo} 行与第 ${clashInBatch.rowNo} 行撞车：${entry.worker}师傅 ${entry.date} ${slotRangeText(entry.start)} 只能承接一单`
      );
    }
    const clashExisting = ctx.appointments
      .filter(isActive)
      .find((appointment) => overlaps(entry, appointment));
    if (clashExisting) {
      errors.push(
        `第 ${entry.rowNo} 行撞车：${entry.worker}师傅 ${entry.date} ${slotRangeText(entry.start)} 已有一单（${repairCaption(ctx.repairs, clashExisting.repairId)}）`
      );
    }
  });

  return { errors, entries };
}

// 已排期待到场事项占用的最晚日期：处理中事项改期不得晚于它。
export function latestBookedDate(appointments) {
  return appointments
    .filter((appointment) => appointment.status === "booked")
    .reduce((max, appointment) => (!max || appointment.date > max ? appointment.date : max), null);
}

// 处理中事项改期校验：字段齐全 + 不撞车 + 不能推到已排事项之后。
export function validateDoingReschedule(input, ctx) {
  const errors = [];
  const repairId = String(input.repairId ?? "").trim();
  const date = String(input.date ?? "").trim();
  const worker = String(input.worker ?? "").trim();
  const start =
    input.start === "" || input.start === null || input.start === undefined
      ? null
      : Number(input.start);

  const missing = [];
  if (!date) missing.push("日期");
  if (start === null || Number.isNaN(start)) missing.push("时段");
  if (!worker) missing.push("师傅");
  if (missing.length) {
    errors.push(`字段不全：缺少 ${missing.join("、")}`);
  }

  const repair = ctx.repairs.find((item) => item.id === repairId);
  if (!repair || repair.status !== "doing") {
    errors.push("只有处理中的事项可以改期");
  }
  const self = findActiveAppointment(ctx.appointments, repairId);
  if (!self) errors.push("该事项没有可改期的上门预约");

  if (errors.length) return { errors, self: self || null };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push("日期格式不正确");
  if (!isValidSlotStart(start)) errors.push("时段不在可选的两小时时段内");
  if (errors.length) return { errors, self };

  const cutoff = latestBookedDate(ctx.appointments);
  if (cutoff && date > cutoff) {
    errors.push(
      `处理中事项不能推到已排事项之后：${date} 晚于最晚已排日期 ${cutoff}`
    );
  }

  const candidate = { repairId, date, start, end: start + 2, worker };
  const clash = ctx.appointments
    .filter(isActive)
    .find((appointment) => appointment.id !== self.id && overlaps(candidate, appointment));
  if (clash) {
    errors.push(
      `时段撞车：${worker}师傅 ${date} ${slotRangeText(start)} 已有一单（${repairCaption(ctx.repairs, clash.repairId)}）`
    );
  }

  return { errors, self, candidate };
}

export function filterRepairs(repairs, filter) {
  if (filter === "all") return repairs;
  return repairs.filter((repair) => repair.status === filter);
}

export function sumCost(repairs) {
  return repairs.reduce((total, repair) => total + Number(repair.cost || 0), 0);
}
