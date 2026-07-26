import readline from "readline";

import { loadFoundation } from "./core/FoundationLoader";
import { loadChronicle } from "./core/ChronicleLoader";
import { loadMeeting } from "./core/MeetingLoader";
import { loadTasks } from "./core/TaskLoader";
import { startDailyCycle } from "./core/DailyCycle";


function header(title:string){
  console.log("\n================================");
  console.log(title);
  console.log("================================");
}


const foundation = loadFoundation();
const chronicle = loadChronicle();
const meeting = loadMeeting();
const tasks = loadTasks();


header("GENESIS FOUNDATION");
console.log("Status:", foundation.status);


header("NEXUS CHRONICLE");
console.log("Status:", chronicle.status);


header("MORNING BRIEFING SYSTEM");
console.log("Status:", meeting.status);


header("GENESIS TASK BOARD");
console.log("Status:", tasks.status);



console.log("\n[Genesis] Runtime active. Type commands...");


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


function showTasks(){

header("GENESIS TASK BOARD");

console.log("\nMission:");
console.log(tasks.mission);


for(const task of tasks.tasks){

console.log(
`\n${task.agent} | ${task.status}
Task: ${task.task}`
);

}

}



function showChronicle(){

header("NEXUS CHRONICLE");

for(const event of chronicle.timeline){

console.log(
`\n${event.day}
${event.title}
${event.description}`
);

}

console.log("\nCurrent Mission:");
console.log(chronicle.currentMission);

console.log("\nNext Mission:");
console.log(chronicle.nextMission);

}



function showMeeting(){

header("COMMAND CHAMBER");
console.log("MORNING BRIEFING");

console.log("\nGenesis:");
console.log(meeting.opening);


console.log("\nAttendance:");

for(const person of meeting.attendees){

console.log(
`- ${person.name} | ${person.role} | ${person.status}`
);

}


console.log("\nToday's Mission:");
console.log(meeting.mission.title);

console.log("\nFocus:");

for(const item of meeting.mission.focus){

console.log("- " + item);

}

}



function runDayStart(){

const cycle = startDailyCycle();

header("DAILY CONSTRUCTION CYCLE");

console.log("Status:", cycle.status);
console.log("Time:", cycle.timestamp);

console.log("\nMission:");
console.log(cycle.mission);

}



rl.on("line",(line)=>{

const command = line.trim();


switch(command){


case "help":
console.log(
"Commands: help, status, chronicle, meeting, tasks, day-start"
);
break;



case "status":

console.log("Genesis Status: ONLINE");
console.log("Foundation:", foundation.status);
console.log("Chronicle:", chronicle.status);
console.log("Meeting:", meeting.status);
console.log("Tasks:", tasks.status);

break;



case "chronicle":

showChronicle();

break;



case "meeting":

showMeeting();

break;



case "tasks":

showTasks();

break;



case "day-start":

runDayStart();

break;



default:

console.log(
"Genesis does not recognize that command."
);

}


});
