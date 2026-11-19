typedef void (*handler_t)(void);

extern int main(void);
extern unsigned int _estack;

void Default_Handler(void)
{
    for (;;) {
    }
}

void Reset_Handler(void)
{
    main();
    for (;;) {
    }
}

__attribute__((section(".isr_vector"), used))
const handler_t vector_table[] = {
    (handler_t)&_estack,
    Reset_Handler,
    Default_Handler,
    Default_Handler,
    Default_Handler,
    Default_Handler,
    Default_Handler
};
