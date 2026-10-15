export type ReviewState="READY"|"APPROVED"|"CHANGES_REQUESTED"|"REJECTED"|"SUPERSEDED";
export function reviewDecision(input:{currentVersion:number;reviewedVersion:number;state:ReviewState;action:"approve"|"revise"|"reject";feedback?:string}){
 if(input.currentVersion!==input.reviewedVersion)throw Error("Stale revision cannot be reviewed");
 if(!["READY","APPROVED"].includes(input.state))throw Error("Revision is not reviewable");
 if(input.action==="revise"&&!input.feedback?.trim())throw Error("A revision requires scoped feedback");
 return {state:input.action==="approve"?"APPROVED":input.action==="reject"?"REJECTED":"CHANGES_REQUESTED",revokePendingPublication:input.action!=="approve",mayRequestRevisionQuote:input.action==="revise",generationAuthorized:false,creditsConsumed:0};
}
