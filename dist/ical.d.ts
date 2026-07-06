export type CalendarItem = {
    id: string;
    title?: string;
    type?: string;
    status?: string;
    priority?: number;
    deadline?: string;
    assignee?: string;
    tags?: string[];
};
export type IcsOptions = {
    calendarName?: string;
    uidDomain?: string;
    now?: Date;
};
export declare function icsEscapeText(value: string): string;
export declare function foldLine(line: string): string;
export declare function formatUtcTimestamp(d: Date): string;
export declare function formatDateValue(d: Date): string;
export declare function itemToVevent(item: CalendarItem, opts: {
    uidDomain: string;
    dtstamp: string;
}): string | null;
export declare function buildIcsCalendar(items: CalendarItem[], opts?: IcsOptions): string;
