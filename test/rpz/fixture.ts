// A small, realistic data set: one library challenge, one program with twin classes, two riders.
export const ME = 'google:111';
export const BUDDY = 'google:222';

export async function seed(db: D1Database) {
  const s = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v);
  await db.batch([
    s(`insert into challenges (id,name,kind,instructors,types,count_from,count_to,status,library_refreshed_on,hidden_by_default)
       values ('CW-PZ','Charlotte''s PZ Cleaners','Library','Charlotte Weidenbach','PZ,PZE,PZMax,PZR,FTP',null,null,'Active','2026-11-15T06:00:00.000Z',0),
              ('P29','Program 29','Program','Multiple','PZ,PZE,PZMax,PC,RR','2026-11-02','2026-12-27','Active','2026-11-17T06:00:00.000Z',0),
              ('OLD','Old one','Library','Matt Wilpers','PZ',null,null,'Active',null,1)`),
    s(`insert into classes (challenge_id,peloton_class_id,class_key,title,instructor,length_min,type,air_epoch,week,slot,retired,source,seq) values
       ('CW-PZ','a1','1708088400|30|30 min power zone ride','30 min Power Zone Ride','Charlotte Weidenbach',30,'PZ',1708088400,null,'',0,'Program',1),
       ('CW-PZ','a2','1708088400|30|30 min power zone ride','30 min Power Zone Ride','Charlotte Weidenbach',30,'PZ',1708088400,null,'',0,'Program',2),
       ('CW-PZ','b1','1753425000|45|45 min power zone ride','45 min Power Zone Ride','Charlotte Weidenbach',45,'PZ',1753425000,null,'',0,'Library',3),
       ('CW-PZ','r1','1700000000|20|20 min power zone recovery ride','20 min Power Zone Recovery Ride','Charlotte Weidenbach',20,'PZR',1700000000,null,'',1,'Library',4),
       ('CW-PZ','x1','1700000100|20|20 min warm up ride','20 min Warm Up Ride','Charlotte Weidenbach',20,'Other',1700000100,null,'',0,'Library',5),
       ('P29','p1','1750000000|45|45 min power zone endurance ride','45 min Power Zone Endurance Ride','Matt Wilpers',45,'PZE',1750000000,1,'Mon',0,'Library',6),
       ('P29','p2','1750100000|60|60 min power zone ride','60 min Power Zone Ride','Denis Morton',60,'PZ',1750100000,6,'Sat',0,'Library',7)`),
    s(`insert into type_rules (ord,title_contains,type,grid_order) values (1,'Power Zone Endurance','PZE',2),(3,'Power Zone Recovery','PZR',1),(5,'Power Zone','PZ',3),(9,'Warm Up','Other',null)`),
    s(`insert into riders (rider_id,email,peloton_username,discord_name,buddy_opt_in,status,visibility,challenge_view,last_sync_on) values
       (?,'me@example.com','spinzalot','',0,'Active','Everyone','+OLD','2026-11-20T12:00:00.000Z'),
       (?,'b@example.com','TheFinder','',1,'Active','Friends','',null)`, ME, BUDDY),
    s(`insert into completions (rider_id,ridden_at,class_key,source) values
       (?,1754000000,'1708088400|30|30 min power zone ride','sync'),
       (?,1794000000,'1750000000|45|45 min power zone endurance ride','sync'),
       (?,1761000000,'1750100000|60|60 min power zone ride','sync'),
       (?,1700500000,'1700000000|20|20 min power zone recovery ride','sync')`, ME, ME, ME, ME),
    s(`insert into friends (rider_id,friend_id) values (?,?),(?,?)`, ME, BUDDY, BUDDY, ME),
    s(`insert into manual (rider_id,challenge_id,peloton_class_id) values (?,'CW-PZ','b1')`, ME),
  ]);
}
