export class Outbox {
  constructor(store) { this.store=store; }
  async dispatch(id,provider) {
    const event=this.store.getOutbox(id);
    if(!event) throw Error('outbox_not_found');
    if(event.status==='delivered') return event;
    this.store.updateOutbox(id,'attempting',null,{ increment:false });
    try {
      const result=await provider.send(event);
      if(result?.status==='delivered') {
        const saved=this.store.updateOutbox(id,'delivered',result.receipt ?? result.path ?? null,{ increment:true });
        return {...saved,...result};
      }
      this.store.updateOutbox(id,'unknown',null,{ increment:true });
      return this.store.getOutbox(id);
    } catch {
      this.store.updateOutbox(id,'unknown',null,{ increment:true });
      return this.store.getOutbox(id);
    }
  }
}
